/**
 * An in-memory stand-in for the parts of BB core this plugin talks to.
 *
 * `retry` ports core's own rules from bb-app 0.46.1
 * (server/src/services/threads/turn-retry.ts and turn-failed.ts): only a
 * thread in `error` with a failed most-recent request can be retried; a named
 * `turnRequestId` must be that request; one live retry per original request
 * (`retry_already_queued`); accepted input continues with an agent-only
 * "Please continue.", unaccepted input is re-sent; the failed request's
 * model, reasoning level, service tier and permission mode are replayed; a
 * busy or offline thread queues the retry as a `retry` row. Like core, every
 * inline attempt and every queued drain first runs the `message.dispatch`
 * hook (the plugin's, wired by the test), except a user's explicit Send-now.
 * Tests drive the provider side (accept, fail, complete) explicitly.
 *
 * Limits: one process, no admission lock, no claimed-row concurrency (tests
 * that need a claimed row set its state by hand) and no provider: "same provider session" here only means core re-used the thread's
 * session id, which the real core does through its normal send path.
 */
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";

/** A `threads.list` row: the `threads.get` DTO plus list-only fields. */
type Thread = ReturnType<typeof makeThreadResponse> & {
  activity: { activeBackgroundAgentCount: number; activeBackgroundCommandCount: number; activeWorkflowCount: number };
  environmentHostId: string | null;
  hasPendingInteraction: boolean;
};
const LIST_ONLY_FIELDS = ["activity", "environmentHostId", "hasPendingInteraction"] as const;

export interface FakeEvent {
  id: string;
  seq: number;
  type: string;
  createdAt: number;
  threadId: string;
  scope: { kind: "thread" };
  data: Record<string, unknown>;
}

export interface Execution {
  model: string;
  reasoningLevel: string;
  serviceTier: string;
  permissionMode: string;
}

export interface FakeQueueRow {
  id: string;
  threadId: string;
  createdAt: number;
  failureReason: string | null;
  sendAt: number | null;
  state: "queued" | "claimed";
  waitingOn: { kind: string; hostName?: string } | null;
  payload:
    | { kind: "inline" }
    | { kind: "retry"; retryOfTurnRequestId: string; attempt: number; reason: string };
  input: Array<Record<string, unknown>>;
  /** The row's input as core's queued-message DTO names it. */
  content: Array<Record<string, unknown>>;
  execution: Execution;
  retryOf: { requestId: string; attempt: number };
}

export class CoreHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
    this.name = "BbHttpError";
  }
}

export const CONTINUE_ACCEPTED_TURN_TEXT = "Please continue.";

export class FakeCore {
  threads = new Map<string, Thread>();
  events = new Map<string, FakeEvent[]>();
  queue: FakeQueueRow[] = [];
  hostsOnline = new Map<string, boolean>();
  providerSessions = new Map<string, string>();
  /** The plugin's `message.dispatch` handler, set by the test after load. */
  hook: ((context: Record<string, unknown>) => unknown) | null = null;
  /** Called when a row is deleted before dispatch (core's `message.cancelled`). */
  onRowCancelled: ((row: FakeQueueRow) => Promise<unknown> | unknown) | null = null;
  private seq = 0;
  private ids = 0;
  now = Date.parse("2026-10-24T05:30:00.000Z");

  addThread(overrides: Partial<Thread> & { id: string; providerId: string }): Thread {
    const { activity, environmentHostId, hasPendingInteraction, ...rest } = overrides;
    const thread: Thread = {
      ...makeThreadResponse({ status: "idle", ...rest }),
      activity: activity ?? { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0 },
      environmentHostId: environmentHostId ?? "host_local",
      hasPendingInteraction: hasPendingInteraction ?? false,
    };
    this.threads.set(thread.id, thread);
    this.events.set(thread.id, []);
    this.providerSessions.set(thread.id, `session-${thread.id}`);
    if (!this.hostsOnline.has(thread.environmentHostId ?? "")) {
      this.hostsOnline.set(thread.environmentHostId ?? "", true);
    }
    return thread;
  }

  thread(id: string): Thread {
    const thread = this.threads.get(id);
    if (thread === undefined) throw new CoreHttpError(404, "thread_not_found", id);
    return thread;
  }

  setThread(id: string, patch: Partial<Thread>): void {
    this.threads.set(id, { ...this.thread(id), ...patch });
  }

  append(threadId: string, type: string, data: Record<string, unknown>): FakeEvent {
    const event: FakeEvent = {
      id: `evt_${++this.ids}`,
      seq: ++this.seq,
      type,
      createdAt: this.now,
      threadId,
      scope: { kind: "thread" },
      data,
    };
    this.events.get(threadId)!.push(event);
    return event;
  }

  /** A user (or retry) dispatch reaching the provider: the thread runs. */
  startTurn(
    threadId: string,
    args: {
      input: Array<Record<string, unknown>>;
      execution: Execution;
      retryOf?: { requestId: string; attempt: number };
      accepted?: boolean;
      /** Core records who asked: `user` (a person or automation), `agent` (another thread), `system`. */
      initiator?: "user" | "agent" | "system";
    },
  ): string {
    const requestId = `creq_${String(++this.ids).padStart(10, "0")}`;
    this.append(threadId, "client/turn/requested", {
      requestId,
      initiator: args.initiator ?? (args.retryOf === undefined ? "user" : "system"),
      input: args.input,
      execution: args.execution,
      ...(args.retryOf === undefined
        ? {}
        : { retryOfRequestId: args.retryOf.requestId, retryAttempt: args.retryOf.attempt }),
    });
    this.append(threadId, "turn/started", {});
    if (args.accepted !== false) {
      this.append(threadId, "turn/input/accepted", {
        providerThreadId: this.providerSessions.get(threadId),
        clientRequestId: requestId,
      });
    }
    this.setThread(threadId, { status: "active" });
    return requestId;
  }

  lastRequest(threadId: string): FakeEvent | null {
    return [...this.events.get(threadId)!].reverse().find((e) => e.type === "client/turn/requested") ?? null;
  }

  /** The provider's final error, then the failed completion core turns into `error`. */
  failTurn(threadId: string, error: { message?: string; detail?: string; errorInfo: Record<string, unknown> | null }): void {
    this.append(threadId, "provider/error", {
      providerThreadId: this.providerSessions.get(threadId),
      message: error.message ?? "Provider error",
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errorInfo === null ? {} : { errorInfo: error.errorInfo }),
    });
    this.append(threadId, "turn/completed", { status: "failed" });
    this.setThread(threadId, { status: "error" });
  }

  interruptTurn(threadId: string, reason: string, cause?: string): void {
    this.append(threadId, "system/thread/interrupted", {
      reason,
      ...(cause === undefined ? {} : { cause }),
    });
    this.setThread(threadId, { status: reason === "manual-stop" || reason === "host-removed" ? "idle" : "error" });
  }

  completeTurn(threadId: string): void {
    this.append(threadId, "turn/completed", { status: "completed" });
    this.setThread(threadId, { status: "idle" });
  }

  /** A tool or model item starting inside the running turn. */
  startItem(threadId: string, type: string): string {
    const id = `item_${++this.ids}`;
    this.append(threadId, "item/started", { item: { id, type, status: "inProgress" } });
    return id;
  }

  completeItem(threadId: string, id: string, type: string): void {
    this.append(threadId, "item/completed", { item: { id, type, status: "completed" } });
  }

  /** The agent's reply, then the completed turn; returns core's `thread.idle` payload. */
  reply(threadId: string, text: string): { thread: Record<string, unknown>; lastAssistantText: string } {
    const id = this.startItem(threadId, "agentMessage");
    this.append(threadId, "item/completed", { item: { id, type: "agentMessage", text } });
    this.completeTurn(threadId);
    return { thread: this.dto(threadId), lastAssistantText: text };
  }

  /** The public thread DTO (`threads.get`, event payloads). */
  dto(threadId: string): Record<string, unknown> {
    const dto: Record<string, unknown> = { ...this.thread(threadId) };
    for (const field of LIST_ONLY_FIELDS) delete dto[field];
    dto.queuedMessageCount = this.queue.filter((row) => row.threadId === threadId).length;
    return dto;
  }

  /** When true, `stop` leaves the thread `stopping` (the machine did not confirm). */
  stopHangs = false;

  /** Claude background work that outlives the failed foreground turn. */
  startBackgroundTask(threadId: string, taskType: string, workflowName?: string): string {
    const itemId = `item_${++this.ids}`;
    this.append(threadId, "item/started", {
      item: { id: itemId, type: "backgroundTask", familyId: `task_${itemId}`, status: "pending", taskStatus: "running", taskType, ...(workflowName === undefined ? {} : { workflowName }) },
    });
    this.countBackgroundTask(threadId, taskType, 1);
    return itemId;
  }

  /**
   * Claude Code's Workflow tool call as BB records it: the call (with
   * `resumeFromRunId` when it resumes a run), the background task it starts,
   * and the call's result, which names the run.
   */
  startWorkflowRun(threadId: string, workflowName: string, runId: string, resumeFromRunId?: string): string {
    const callId = `item_${++this.ids}`;
    const itemId = `item_${++this.ids}`;
    const args = resumeFromRunId === undefined ? { script: "export const meta = {}" } : { resumeFromRunId };
    this.append(threadId, "item/started", { item: { id: callId, type: "toolCall", tool: "Workflow", arguments: args, status: "inProgress" } });
    this.append(threadId, "item/started", {
      item: { id: itemId, type: "backgroundTask", familyId: `task_${itemId}`, status: "pending", taskStatus: "running", taskType: "local_workflow", workflowName, parentToolCallId: callId },
    });
    this.append(threadId, "item/completed", {
      item: { id: callId, type: "toolCall", tool: "Workflow", arguments: args, status: "completed", result: `Workflow launched in background.\nRun ID: ${runId}` },
    });
    this.countBackgroundTask(threadId, "local_workflow", 1);
    return itemId;
  }

  private countBackgroundTask(threadId: string, taskType: string, delta: number): void {
    const activity = this.thread(threadId).activity;
    this.setThread(threadId, {
      activity: {
        ...activity,
        activeWorkflowCount: activity.activeWorkflowCount + (taskType === "local_workflow" ? delta : 0),
        activeBackgroundCommandCount: activity.activeBackgroundCommandCount + (taskType === "local_bash" ? delta : 0),
      },
    });
  }

  private openBackgroundItems(threadId: string): Array<Record<string, unknown>> {
    const events = this.events.get(threadId)!;
    const closed = new Set(events.filter((e) => e.type === "item/backgroundTask/completed").map((e) => (e.data.item as { id: string }).id));
    return events
      .filter((e) => e.type === "item/started" && (e.data.item as { type: string }).type === "backgroundTask")
      .map((e) => e.data.item as Record<string, unknown>)
      .filter((item) => !closed.has(item.id as string));
  }

  /** Claude Code's own close (finished, TaskStop, a manual stop): the provider adds a presentation. */
  closeBackgroundTask(threadId: string, itemId: string, taskStatus: "completed" | "failed" | "stopped"): void {
    const item = this.openBackgroundItems(threadId).find((open) => open.id === itemId)!;
    this.append(threadId, "item/backgroundTask/completed", {
      providerThreadId: this.providerSessions.get(threadId),
      item: { ...item, status: taskStatus === "stopped" ? "interrupted" : taskStatus, taskStatus, presentation: { title: "Workflow" } },
    });
    this.countBackgroundTask(threadId, item.taskType as string, -1);
  }

  /**
   * core's settleDanglingBackgroundTasks when the machine's daemon was
   * replaced (BB restart, host daemon restart) or lost: every task still
   * open is closed as stopped from the item it last stored, no presentation.
   */
  settleBackgroundTasks(threadId: string): void {
    for (const item of this.openBackgroundItems(threadId)) {
      this.append(threadId, "item/backgroundTask/completed", {
        providerThreadId: this.providerSessions.get(threadId),
        item: { ...item, status: "interrupted", taskStatus: "stopped" },
      });
      this.countBackgroundTask(threadId, item.taskType as string, -1);
    }
  }

  /** core's dispatch-hooks.ts pass, reduced to one plugin. */
  async runHook(
    threadId: string,
    rows: FakeQueueRow[],
    inline: Array<Record<string, unknown>> = [],
  ): Promise<{ action: string; reason?: string; message?: string; sendAt?: number | null }> {
    if (this.hook === null) return { action: "proceed" };
    const dto: Record<string, unknown> = { ...this.thread(threadId) };
    for (const field of LIST_ONLY_FIELDS) delete dto[field];
    // core's combined input: the rows' content, or the inline message being sent.
    const blocks = rows.length > 0 ? rows.flatMap((row) => row.content) : inline;
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text as string).join("\n");
    return (await this.hook({ thread: dto, queuedMessages: rows.map((row) => ({ ...row })), input: { blocks, text } })) as never;
  }

  /** core's queue drain: each eligible row runs the hook pass, then dispatches. */
  async drain(): Promise<void> {
    for (const row of [...this.queue]) {
      const thread = this.thread(row.threadId);
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (row.waitingOn?.kind === "host-offline" && this.hostsOnline.get(thread.environmentHostId ?? "") === false) continue;
      if (row.sendAt !== null && row.sendAt > this.now) continue;
      if (thread.status === "active") continue;
      const decision = await this.runHook(row.threadId, [row]);
      if (decision.action === "wait") {
        row.waitingOn = { kind: "plugin" };
        if (decision.sendAt != null) row.sendAt = decision.sendAt;
        continue;
      }
      if (decision.action === "reject") {
        row.failureReason = decision.message ?? "rejected";
        continue;
      }
      if (!this.queue.includes(row)) continue;
      this.queue = this.queue.filter((r) => r !== row);
      this.startTurn(row.threadId, {
        input: row.input,
        execution: row.execution,
        ...(row.payload.kind === "retry" ? { retryOf: row.retryOf } : {}),
      });
    }
  }

  // --- core retry (turn-retry.ts) -----------------------------------------
  private retriesInFlight = new Set<string>();

  private failedTurn(threadId: string): { request: FakeEvent; accepted: boolean } {
    const thread = this.thread(threadId);
    if (thread.status !== "error") {
      throw new CoreHttpError(409, "no_failed_turn", `Thread ${threadId} has no failed turn to retry: it is ${thread.status}.`);
    }
    const request = this.lastRequest(threadId);
    if (request === null) throw new CoreHttpError(409, "no_failed_turn", "never dispatched");
    const requestId = request.data.requestId as string;
    const accepted = this.events
      .get(threadId)!
      .some((e) => e.seq > request.seq && e.type === "turn/input/accepted" && e.data.clientRequestId === requestId);
    return { request, accepted };
  }

  async retry(args: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }) {
    const { request, accepted } = this.failedTurn(args.threadId);
    const data = request.data as {
      requestId: string;
      retryOfRequestId?: string;
      retryAttempt?: number;
      input: Array<Record<string, unknown>>;
      execution: Execution;
    };
    if (args.turnRequestId !== undefined && args.turnRequestId !== data.requestId) {
      throw new CoreHttpError(409, "no_failed_turn", `Turn ${args.turnRequestId} is not the failed turn.`);
    }
    const originalRequestId = data.retryOfRequestId ?? data.requestId;
    const key = `${args.threadId}:${originalRequestId}`;
    const queued = this.queue.some(
      (row) => row.threadId === args.threadId && row.payload.kind === "retry" && row.payload.retryOfTurnRequestId === originalRequestId,
    );
    if (this.retriesInFlight.has(key) || queued) {
      throw new CoreHttpError(409, "retry_already_queued", `Turn ${originalRequestId} already has a retry waiting.`);
    }
    this.retriesInFlight.add(key);
    try {
      const attempt = (data.retryAttempt ?? 1) + 1;
      const input = accepted
        ? [{ type: "text", text: CONTINUE_ACCEPTED_TURN_TEXT, mentions: [], visibility: "agent-only" }]
        : data.input.map((block) => ({ ...block, visibility: "agent-only" }));
      const execution = { ...data.execution };
      const retryOf = { requestId: originalRequestId, attempt };
      const thread = this.thread(args.threadId);
      const hostOnline = this.hostsOnline.get(thread.environmentHostId ?? "") !== false;
      const future = args.sendAt !== undefined && args.sendAt > this.now;
      // dispatch-attempt.ts runs the hook pass before scheduling or host waits.
      const decision = await this.runHook(args.threadId, []);
      if (decision.action === "reject") throw new CoreHttpError(409, "dispatch_rejected", decision.message ?? "rejected");
      const pluginWait = decision.action === "wait";
      if (future || !hostOnline || pluginWait) {
        const row: FakeQueueRow = {
          id: `qmsg_${++this.ids}`,
          threadId: args.threadId,
          createdAt: this.now,
          failureReason: null,
          sendAt: args.sendAt ?? null,
          state: "queued",
          waitingOn: pluginWait
            ? { kind: "plugin" }
            : future
              ? { kind: "time" }
              : { kind: "host-offline", hostName: thread.environmentHostId ?? "" },
          payload: { kind: "retry", retryOfTurnRequestId: originalRequestId, attempt, reason: args.reason ?? "" },
          input,
          content: input,
          execution,
          retryOf,
        };
        this.queue.push(row);
        return { ok: true, delivery: "queued", turnRequestId: originalRequestId, attempt, queuedMessageId: row.id, waitingOn: row.waitingOn, sendAt: row.sendAt };
      }
      this.startTurn(args.threadId, { input, execution, retryOf });
      return { ok: true, delivery: "sent", turnRequestId: originalRequestId, attempt };
    } finally {
      this.retriesInFlight.delete(key);
    }
  }

  /** Host comes back: core drains the queue (each row through the hook pass). */
  async setHostOnline(hostId: string, online: boolean): Promise<void> {
    this.hostsOnline.set(hostId, online);
    if (online) await this.drain();
  }

  // --- the SDK surface the plugin uses ------------------------------------
  sdk() {
    return {
      threads: {
        count: async (args: { status?: string } = {}) => ({
          total: [...this.threads.values()].filter(
            (t) => t.archivedAt === null && t.deletedAt === null && (args.status === undefined || t.status === args.status),
          ).length,
        }),
        list: async (args: { archived?: boolean; includeHidden?: boolean; limit?: number; offset?: number; parentThreadId?: string } = {}) => {
          const rows = [...this.threads.values()].filter(
            (t) =>
              t.deletedAt === null &&
              (args.parentThreadId === undefined || t.parentThreadId === args.parentThreadId) &&
              (args.archived === true ? t.archivedAt !== null : t.archivedAt === null) &&
              (args.includeHidden === true || t.visibility !== "hidden"),
          );
          const offset = args.offset ?? 0;
          return rows.slice(offset, offset + (args.limit ?? 100));
        },
        get: async ({ threadId }: { threadId: string }) => this.dto(threadId),
        listRunning: async () =>
          [...this.threads.values()]
            .filter((t) => t.status === "active" && t.archivedAt === null && t.deletedAt === null)
            .map((t) => ({ id: t.id, hostId: t.environmentHostId })),
        // core: a manual stop interrupts the running turn and settles the thread idle.
        stop: async ({ threadId }: { threadId: string }) => {
          const thread = this.thread(threadId);
          if (thread.status !== "active") return { ok: true };
          if (this.stopHangs) {
            this.setThread(threadId, { status: "stopping" as never });
            return { ok: true };
          }
          this.append(threadId, "turn/completed", { status: "interrupted" });
          this.interruptTurn(threadId, "manual-stop");
          return { ok: true };
        },
        // core's send: hook pass, then dispatch, or a queued row behind a busy thread.
        send: async (args: { threadId: string; input: Array<Record<string, unknown>>; mode: string; model?: string; reasoningLevel?: string; serviceTier?: string; permissionMode?: string }) => {
          const thread = this.thread(args.threadId);
          const decision = await this.runHook(args.threadId, [], args.input);
          if (decision.action === "reject") throw new CoreHttpError(409, "dispatch_rejected", decision.message ?? "rejected");
          const execution: Execution = {
            model: args.model ?? "thread-default",
            reasoningLevel: args.reasoningLevel ?? "thread-default",
            serviceTier: args.serviceTier ?? "thread-default",
            permissionMode: args.permissionMode ?? "thread-default",
          };
          if (thread.status === "active" || decision.action === "wait") {
            this.queue.push({
              id: `qmsg_${++this.ids}`,
              threadId: args.threadId,
              createdAt: this.now,
              failureReason: null,
              sendAt: null,
              state: "queued",
              waitingOn: { kind: "thread-busy" },
              payload: { kind: "inline" },
              input: args.input,
              content: args.input,
              execution,
              retryOf: { requestId: "", attempt: 0 },
            });
            return { ok: true, delivery: "queued" };
          }
          this.startTurn(args.threadId, { input: args.input, execution });
          return { ok: true, delivery: "sent" };
        },
        interactions: {
          list: async ({ threadId }: { threadId: string }) =>
            this.thread(threadId).hasPendingInteraction ? [{ id: `int_${threadId}` }] : [],
        },
        retry: async (args: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }) => this.retry(args),
        events: {
          list: async (args: { threadId: string; types?: string[]; order?: "asc" | "desc"; limit?: string; afterSeq?: string; beforeSeq?: string }) => {
            let rows = (this.events.get(args.threadId) ?? []).filter(
              (e) =>
                (args.types === undefined || args.types.includes(e.type)) &&
                (args.afterSeq === undefined || e.seq > Number(args.afterSeq)) &&
                (args.beforeSeq === undefined || e.seq < Number(args.beforeSeq)),
            );
            if (args.order === "desc") rows = [...rows].reverse();
            return rows.slice(0, Number(args.limit ?? 100));
          },
        },
        queue: {
          list: async (args: { threadId?: string } = {}) =>
            this.queue.filter((row) => args.threadId === undefined || row.threadId === args.threadId),
        },
        queuedMessages: {
          delete: async ({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) => {
            const row = this.queue.find((r) => r.threadId === threadId && r.id === queuedMessageId);
            this.queue = this.queue.filter((r) => r !== row);
            if (row !== undefined) await this.onRowCancelled?.(row);
            return { ok: true };
          },
          send: async ({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) => {
            const row = this.queue.find((r) => r.threadId === threadId && r.id === queuedMessageId);
            if (row === undefined) throw new CoreHttpError(404, "not_found", queuedMessageId);
            this.queue = this.queue.filter((r) => r !== row);
            this.startTurn(threadId, { input: row.input, execution: row.execution, retryOf: row.retryOf });
            return { ok: true };
          },
        },
      },
      plugins: { experimental_discoverRpc: async () => [] },
    };
  }
}

export const OPUS_ULTRACODE: Execution = {
  model: "claude-opus-5-5",
  reasoningLevel: "ultracode",
  serviceTier: "default",
  permissionMode: "auto",
};

export const CODEX_HIGH: Execution = {
  model: "gpt-6-astra",
  reasoningLevel: "high",
  serviceTier: "default",
  permissionMode: "auto",
};

/** Final errors exactly as the incident's threads recorded them (no ids). */
export const FAILURES = {
  claudePooler: {
    detail:
      "API Error: 502 Account Pooler could not reach Anthropic. This is a server-side issue, usually temporary — try again in a moment.",
    errorInfo: { category: "internal", providerCode: null, httpStatusCode: 502 },
  },
  codexPooler: {
    detail:
      "unexpected status 502 Bad Gateway: Account Pooler could not reach ChatGPT., url: http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1/responses",
    errorInfo: { category: "connection-failed", providerCode: "httpConnectionFailed", httpStatusCode: 502 },
  },
  claudeOffline: {
    detail: "API Error: Connection error.",
    errorInfo: { category: "unknown", providerCode: null, httpStatusCode: null },
  },
  codexStream: {
    detail: "stream disconnected before completion: error sending request for url",
    errorInfo: { category: "stream-disconnected", providerCode: null, httpStatusCode: null },
  },
  providerInternal500: {
    detail: "API Error: 500 Internal server error",
    errorInfo: { category: "internal", providerCode: "api_error", httpStatusCode: 500 },
  },
  unauthorized: {
    detail: "API Error: 401 authentication_error: invalid x-api-key",
    errorInfo: { category: "unauthorized", providerCode: null, httpStatusCode: 401 },
  },
  billing: {
    detail: "Credit balance is too low",
    errorInfo: { category: "billing", providerCode: null, httpStatusCode: 400 },
  },
  rateLimit: {
    detail: "usage limit reached",
    errorInfo: { category: "rate-limit", providerCode: "usage_limit_reached", httpStatusCode: 429 },
  },
  overloaded: {
    detail: "Overloaded",
    errorInfo: { category: "overloaded", providerCode: "overloaded_error", httpStatusCode: 529 },
  },
} as const;
