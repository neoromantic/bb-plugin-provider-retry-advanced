import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { RetryDiagnostic } from "./diagnostics.js";
import type { ProbeFn, ProbeResult } from "./probe.js";
import {
  hasPendingInteraction,
  isOwnMessage,
  latestRequest,
  listEvents,
  openBackgroundWork,
  parseRequest,
  requestsAfter,
  sendAgentOnly,
  WORKFLOW_TAG,
  workflowText,
} from "./continuations.js";
import {
  classifyFailedTurn,
  type EventLike,
  type FailureClass,
  type ProbeTargetId,
} from "./transport.js";

/** Fixed delay between scans. Transport recovery has no attempt limit and no backoff. */
export const SCAN_INTERVAL_MS = 60_000;

/** Shown verbatim on the queued retry card; also marks this plugin's own rows. */
export const TRANSPORT_RETRY_REASON = "Connectivity restored";

const OWN_RETRY_REASONS = new Set([TRANSPORT_RETRY_REASON, "Rate limited", "Provider overloaded"]);

const ARMED_KEY = "armed";

const WORKFLOW_ENGINE_PLUGIN_ID = "workflows";

const LIST_PAGE_SIZE = 200;

const NOT_READY_WAIT_MS = 10_000;

export type ScanEntryState = "resumed" | "waiting" | "skipped";

export interface ScanEntry {
  threadId: string;
  requestId: string | null;
  state: ScanEntryState;
  reason: string;
  /** Open Claude background work (workflows, agents, commands) at scan time. */
  openBackgroundTasks?: number;
}

export interface ScanReport {
  at: number;
  enabled: boolean;
  /** False until `arm` after a fresh install: nothing is retried, scans only report. */
  armed: boolean;
  errorThreads: number;
  entries: ScanEntry[];
  probes: Partial<Record<ProbeTargetId, ProbeResult>>;
  staleRowsRemoved: number;
}

interface FailedTurn {
  requestSeq: number;
  terminalSeq: number | null;
  requestId: string;
  originalRequestId: string;
  failure: FailureClass;
}

interface ThreadState {
  id: string;
  status: string;
  providerId: string;
  archivedAt: number | null;
  deletedAt: number | null;
}

interface ThreadRow extends ThreadState {
  hasPendingInteraction: boolean;
  originPluginId: string | null;
  activity?: {
    activeBackgroundAgentCount: number;
    activeBackgroundCommandCount: number;
    activeWorkflowCount: number;
  };
}

type QueueRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queue"]["list"]>>[number];
type DispatchDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string; sendAt?: number | null }
  | { action: "reject"; message: string };

interface TaskItem {
  id: string;
  type: string;
  taskType?: string;
  taskStatus?: string;
  workflowName?: string;
  familyId?: string;
  parentToolCallId?: string;
  presentation?: unknown;
  tool?: string;
  arguments?: { resumeFromRunId?: string };
  result?: unknown;
}

interface WorkflowOrigin {
  runId: string | null;
  chain: string | null;
}

interface WorkflowRecord {
  sinceAt: number;
  origins: Record<string, WorkflowOrigin>;
  asked: string[];
}

interface KilledWorkflow extends WorkflowOrigin {
  seq: number;
  id: string;
  task: string;
  name: string;
}

const RUN_ID = /Run ID: (wf_[A-Za-z0-9-]+)/;

function isWorkflowRow(row: QueueRow) {
  return row.content.some((block) => block.type === "text" && block.text.startsWith(WORKFLOW_TAG));
}

interface SkipRecord {
  originalRequestId: string;
  at: number;
}

export interface TransportRecoveryOptions {
  probe: ProbeFn;
  enabled: () => boolean;
  /** The `workflowRecovery` setting: resume Claude Code workflows a restart killed. */
  workflowRecovery: () => boolean;
  now?: () => number;
}

export interface TransportRecovery {
  /** Loads holds, cancellations and the armed flag; call before registering the hook. */
  init(): Promise<void>;
  /** One scan; concurrent callers share the scan already running. */
  scan(): Promise<ScanReport>;
  lastReport(): ScanReport | null;
  isArmed(): boolean;
  /** Allow automatic retries (once after install); returns the scan it runs. */
  arm(): Promise<ScanReport>;
  /** Never retry this thread automatically until released; withdraws its queued own retries. */
  hold(threadId: string): Promise<void>;
  /** Clear a hold and a cancelled failure for this thread. */
  release(threadId: string): Promise<void>;
  isHeld(threadId: string): boolean;
  /** Stop auto-recovering the thread's current failed turn chain and withdraw its rows. */
  skipCurrentFailure(threadId: string): Promise<string | null>;
  /** Any turn on the thread failed (core's `turn.failed`). */
  noteFailure(threadId: string): void;
  /** A queued retry row was removed before it dispatched. */
  onRetryRowCancelled(entry: {
    id: string;
    threadId: string;
    payload: { kind: string; retryOfTurnRequestId?: string };
  }): Promise<void>;
  /** The `message.dispatch` checkpoint: core asks before every attempt and every drain. */
  decideDispatch(context: MessageDispatchHookContext): DispatchDecision | Promise<DispatchDecision>;
}

function openBackgroundTasks(thread: ThreadRow) {
  const activity = thread.activity;
  if (activity === undefined) return 0;
  return (
    activity.activeWorkflowCount +
    activity.activeBackgroundAgentCount +
    activity.activeBackgroundCommandCount
  );
}

function errorStatus(error: unknown) {
  const value = error as { status?: unknown; code?: unknown } | null;
  return {
    status: typeof value?.status === "number" ? value.status : null,
    code: typeof value?.code === "string" ? value.code : null,
  };
}

export function isOwnRetryRow(row: Pick<QueueRow, "payload">): row is QueueRow & {
  payload: { kind: "retry"; retryOfTurnRequestId: string; reason: string; attempt: number };
} {
  return row.payload.kind === "retry" && OWN_RETRY_REASONS.has(row.payload.reason);
}

export function createTransportRecovery(bb: BbPluginApi, options: TransportRecoveryOptions) {
  const now = options.now ?? Date.now;
  const failedTurns = new Map<string, FailedTurn>();
  const recorded = new Map<string, string>();
  const held = new Set<string>();
  const skipped = new Map<string, string>();
  let armed = false;
  const currentChain = new Map<string, string>();
  const generation = new Map<string, number>();
  const refreshing = new Set<string>();
  const inflight = new Map<string, string>();
  const selfDeleting = new Set<string>();
  const workflowsSeen = new Map<string, WorkflowRecord>();
  const workflowReady = new Map<string, number>();
  let running: Promise<ScanReport> | null = null;
  let last: ScanReport | null = null;

  async function listThreads() {
    const rows: ThreadRow[] = [];
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const page = (await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit: LIST_PAGE_SIZE,
        offset,
      })) as unknown as ThreadRow[];
      rows.push(...page);
      if (page.length < LIST_PAGE_SIZE) return rows;
    }
  }

  async function forgetWorkflow(threadId: string) {
    workflowsSeen.delete(threadId);
    workflowReady.delete(threadId);
    await bb.storage.kv.delete(`workflow:${threadId}`);
  }

  async function killedWorkflows(threadId: string, record: WorkflowRecord) {
    const killed: KilledWorkflow[] = [];
    for (let before: number | undefined; ;) {
      const page = await listEvents(bb, {
        threadId,
        types: ["item/backgroundTask/completed"],
        beforeSeq: before,
        order: "desc",
        limit: LIST_PAGE_SIZE,
      });
      const recent = page.filter((event) => (event.createdAt ?? 0) >= record.sinceAt);
      for (const event of recent) {
        const item = (event.data as { item: TaskItem }).item;
        if (
          item.taskType !== "local_workflow" ||
          item.taskStatus !== "stopped" ||
          item.presentation !== undefined
        )
          continue;
        if (record.origins[item.id] === undefined) {
          const origin: WorkflowOrigin = { runId: null, chain: null };
          for (let startBefore = event.seq; ;) {
            const starts = await listEvents(bb, {
              threadId,
              types: ["item/started"],
              beforeSeq: startBefore,
              order: "desc",
              limit: LIST_PAGE_SIZE,
            });
            const start = starts.find(
              (started) => (started.data as { item: TaskItem }).item.id === item.id,
            );
            if (start !== undefined) {
              const completed = await listEvents(bb, {
                threadId,
                types: ["item/completed"],
                afterSeq: start.seq,
                order: "asc",
                limit: 50,
              });
              const call = completed.find(
                (done) => (done.data as { item: TaskItem }).item.id === item.parentToolCallId,
              );
              if (call !== undefined) {
                const match = RUN_ID.exec(String((call.data as { item: TaskItem }).item.result));
                if (match !== null) origin.runId = match[1]!;
              }
              const [request] = await listEvents(bb, {
                threadId,
                types: ["client/turn/requested"],
                beforeSeq: start.seq,
                order: "desc",
                limit: 1,
              });
              if (request !== undefined) {
                const parsed = parseRequest(request);
                origin.chain = parsed.retryOfRequestId ?? parsed.requestId;
              }
              break;
            }
            if (starts.length < LIST_PAGE_SIZE) break;
            startBefore = starts.at(-1)!.seq;
          }
          record.origins[item.id] = origin;
        }
        killed.unshift({
          seq: event.seq,
          id: item.id,
          task: String(item.familyId),
          name: String(item.workflowName),
          ...record.origins[item.id]!,
        });
      }
      if (page.length < LIST_PAGE_SIZE || recent.length < page.length) break;
      before = page.at(-1)!.seq;
    }
    if (killed.length === 0) return killed;
    const resumes: Array<{ seq: number; runId: string }> = [];
    for (let afterSeq = killed[0]!.seq; ;) {
      const page = await listEvents(bb, {
        threadId,
        types: ["item/started"],
        afterSeq,
        order: "asc",
        limit: LIST_PAGE_SIZE,
      });
      for (const event of page) {
        const item = (event.data as { item: TaskItem }).item;
        if (item.tool === "Workflow" && item.arguments?.resumeFromRunId !== undefined)
          resumes.push({ seq: event.seq, runId: item.arguments.resumeFromRunId });
      }
      if (page.length < LIST_PAGE_SIZE) break;
      afterSeq = page.at(-1)!.seq;
    }
    return killed.filter(
      (run) => !resumes.some((resume) => resume.seq > run.seq && resume.runId === run.runId),
    );
  }

  function workflowBlocked(threadId: string) {
    if (!options.workflowRecovery()) return "setting-off";
    if (!armed) return "not-armed";
    if (held.has(threadId)) return "held";
    const record = workflowsSeen.get(threadId);
    if (record === undefined) return "withdrawn";
    if (
      record.asked.some(
        (id) =>
          record.origins[id]!.chain !== null && skipped.get(threadId) === record.origins[id]!.chain,
      )
    )
      return "cancelled";
    return null;
  }

  async function checkWorkflow(
    thread: Pick<ThreadRow, "id" | "status" | "originPluginId">,
    record: WorkflowRecord,
  ) {
    const [latest] = await listEvents(bb, { threadId: thread.id, order: "desc", limit: 1 });
    const all = await killedWorkflows(thread.id, record);
    const killed = all.filter((run) => run.chain === null || skipped.get(thread.id) !== run.chain);
    if (all.length === 0) return { state: "skipped", reason: "workflow-finished-or-resumed" };
    if (killed.length === 0) return { state: "skipped", reason: "cancelled" };
    if (killed.some((run) => run.chain === null))
      return { state: "waiting", reason: "workflow-origin-unknown" };
    if (held.has(thread.id)) return { state: "skipped", reason: "held" };
    if (thread.originPluginId === WORKFLOW_ENGINE_PLUGIN_ID)
      return { state: "skipped", reason: "workflow-engine-owned" };
    const stops = await listEvents(bb, {
      threadId: thread.id,
      types: ["system/thread/interrupted"],
      order: "desc",
      limit: 50,
    });
    if (
      stops.some(
        (event) =>
          (event.createdAt ?? 0) >= record.sinceAt &&
          (event.data as { reason?: unknown }).reason === "manual-stop",
      )
    ) {
      return { state: "skipped", reason: "stopped-by-user" };
    }
    const after = await requestsAfter(bb, thread.id, killed[0]!.seq);
    if (after.some((request) => request.text.startsWith(WORKFLOW_TAG)))
      return { state: "skipped", reason: "already-sent" };
    if (
      after.some(
        (r) =>
          !isOwnMessage(r) &&
          r.retryOfRequestId === null &&
          (r.initiator === "user" || r.initiator === "agent"),
      )
    ) {
      return { state: "skipped", reason: "a-newer-message-took-over" };
    }
    if (thread.status !== "idle") return { state: "waiting", reason: `thread-${thread.status}` };
    if (await hasPendingInteraction(bb, thread.id))
      return { state: "waiting", reason: "pending-interaction" };
    if (!armed)
      return { state: "waiting", reason: "not-armed (run: bb provider-retry-advanced arm)" };
    if ((await openBackgroundWork(bb, thread.id)) > 0)
      return { state: "waiting", reason: "background-work-open" };
    const queued = await bb.sdk.threads.queue.list({ threadId: thread.id });
    record.asked = killed.map((run) => run.id);
    if (queued.some(isWorkflowRow))
      return { state: "waiting", reason: "message-queued", seq: latest!.seq };
    if (queued.length > 0) return { state: "waiting", reason: "other-message-queued" };
    const labels: string[] = [];
    for (const run of killed) {
      if (run.runId === null)
        labels.push(
          `"${run.name}" (Claude Code task ${run.task}, run id unknown: check that task's run and status)`,
        );
      else labels.push(`"${run.name}" (run ${run.runId})`);
    }
    return { state: "ready", reason: "interrupted-workflow", labels, seq: latest!.seq };
  }

  function refreshWorkflow(threadId: string) {
    const record = workflowsSeen.get(threadId);
    if (record === undefined || refreshing.has(`workflow:${threadId}`)) return;
    refreshing.add(`workflow:${threadId}`);
    void (async () => {
      try {
        const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadRow;
        const decision = await checkWorkflow({ ...thread, status: "idle" }, record);
        if (decision.reason === "message-queued") workflowReady.set(threadId, decision.seq!);
        await bb.storage.kv.set(`workflow:${threadId}`, record);
        if (decision.state === "skipped") {
          await forgetWorkflow(threadId);
          await withdrawThreadRows(threadId, `workflow ${decision.reason}`);
        }
        await bb.experimental_hooks.recheck("message.dispatch");
      } catch (error) {
        bb.log.warn(`Could not check the interrupted workflow of ${threadId}: ${String(error)}`);
      } finally {
        refreshing.delete(`workflow:${threadId}`);
      }
    })();
  }

  async function checkWorkflows(threads: ThreadRow[], report: ScanReport) {
    const rows = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of threads) {
      if (
        thread.activity === undefined ||
        thread.activity.activeWorkflowCount === 0 ||
        workflowsSeen.has(thread.id)
      )
        continue;
      const record: WorkflowRecord = { sinceAt: report.at, origins: {}, asked: [] };
      workflowsSeen.set(thread.id, record);
      await bb.storage.kv.set(`workflow:${thread.id}`, record);
    }
    for (const [threadId, record] of workflowsSeen) {
      const thread = rows.get(threadId);
      if (
        thread !== undefined &&
        thread.activity !== undefined &&
        thread.activity.activeWorkflowCount > 0
      )
        continue;
      const entry: ScanEntry = {
        threadId,
        requestId: null,
        state: "skipped",
        reason: "workflow:thread-archived-or-deleted",
        openBackgroundTasks: 0,
      };
      report.entries.push(entry);
      if (thread === undefined) {
        await forgetWorkflow(threadId);
        continue;
      }
      entry.openBackgroundTasks = openBackgroundTasks(thread);
      try {
        const decision = await checkWorkflow(thread, record);
        entry.reason = `workflow:${decision.reason}`;
        await bb.storage.kv.set(`workflow:${threadId}`, record);
        if (decision.state === "skipped") {
          await forgetWorkflow(threadId);
          await withdrawThreadRows(threadId, `workflow ${decision.reason}`);
          continue;
        }
        if (decision.state === "waiting") {
          entry.state = "waiting";
          continue;
        }
        const request = await latestRequest(bb, threadId);
        workflowReady.set(threadId, decision.seq!);
        await sendAgentOnly(bb, {
          threadId,
          text: workflowText(decision.labels!),
          execution: request!.execution,
        });
        entry.state = "resumed";
        bb.log.info(
          `Interrupted workflow: ${threadId} lost ${decision.labels!.length} Claude Code workflow(s) to a restart; sent one message to resume.`,
        );
      } catch (error) {
        workflowReady.delete(threadId);
        entry.state = "waiting";
        entry.reason = `workflow:send-failed`;
        bb.log.warn(
          `Could not ask ${threadId} to resume its interrupted workflow: ${String(error)}`,
        );
      }
    }
  }

  async function firstEvent(args: {
    threadId: string;
    types: [string, ...string[]];
    afterSeq: number;
    beforeSeq?: number;
    order: "asc" | "desc";
  }) {
    const [event]: EventLike[] = await bb.sdk.threads.events.list({
      threadId: args.threadId,
      types: args.types as never,
      afterSeq: String(args.afterSeq),
      ...(args.beforeSeq === undefined ? {} : { beforeSeq: String(args.beforeSeq) }),
      order: args.order,
      limit: "1",
    });
    return event;
  }

  async function loadFailedTurn(thread: ThreadState) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = generation.get(thread.id) ?? 0;
      const read = await readFailedTurn(thread);
      if ((generation.get(thread.id) ?? 0) !== started) continue;
      if (read === null) return null;
      currentChain.set(thread.id, read.originalRequestId);
      if (read.failure.kind !== "other" || read.failure.reason !== "incomplete")
        failedTurns.set(thread.id, read);
      return read;
    }
    return null;
  }

  async function readFailedTurn(thread: ThreadState) {
    const [request] = await bb.sdk.threads.events.list({
      threadId: thread.id,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
    });
    if (request === undefined) return null;
    const latest = (type: string, beforeSeq?: number) =>
      firstEvent({
        threadId: thread.id,
        types: [type],
        afterSeq: request.seq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        order: "desc",
      });
    const completion = await latest("turn/completed");
    const interrupted = await latest("system/thread/interrupted");
    const terminal = [completion, interrupted]
      .filter((event): event is EventLike => event !== undefined)
      .sort((a, b) => b.seq - a.seq)[0];
    const cached = failedTurns.get(thread.id);
    if (
      cached !== undefined &&
      cached.requestSeq === request.seq &&
      cached.terminalSeq === (terminal?.seq ?? null)
    ) {
      return cached;
    }
    const data = request.data as { requestId: string; retryOfRequestId?: string };
    const base = {
      requestSeq: request.seq,
      terminalSeq: terminal?.seq ?? null,
      requestId: data.requestId,
      originalRequestId: data.retryOfRequestId ?? data.requestId,
    };
    if (terminal === undefined)
      return { ...base, failure: { kind: "other", reason: "incomplete" } } satisfies FailedTurn;
    if (
      terminal.type === "turn/completed" &&
      (terminal.data as { status?: unknown }).status !== "failed"
    ) {
      return {
        ...base,
        failure: {
          kind: "other",
          reason: `latest-turn-${String((terminal.data as { status?: unknown }).status)}`,
        },
      } satisfies FailedTurn;
    }
    if (terminal.type === "system/thread/interrupted") {
      return {
        ...base,
        failure: classifyFailedTurn({ providerId: thread.providerId, events: [terminal] }),
      } satisfies FailedTurn;
    }
    const previous = await latest("turn/completed", terminal.seq);
    const decisive = await firstEvent({
      threadId: thread.id,
      types: ["provider/error"],
      afterSeq: previous?.seq ?? request.seq,
      beforeSeq: terminal.seq,
      order: "desc",
    });
    const events = [decisive, terminal].filter((event): event is EventLike => event !== undefined);
    return {
      ...base,
      failure: classifyFailedTurn({ providerId: thread.providerId, events }),
    } satisfies FailedTurn;
  }

  async function record(entry: ScanEntry, at: number) {
    if (entry.requestId === null) return;
    const key = `${entry.requestId}:${entry.state}:${entry.reason}`;
    if (recorded.get(entry.threadId) === key) return;
    recorded.set(entry.threadId, key);
    const diagnostic: RetryDiagnostic = {
      requestId: entry.requestId,
      observedAt: at,
      availability: { kind: "not-routed" },
      decision:
        entry.state === "resumed"
          ? { kind: "retry", reason: TRANSPORT_RETRY_REASON, sendAt: at }
          : { kind: "decline", reason: entry.reason },
    };
    await bb.storage.kv.set(`decision:${entry.threadId}`, diagnostic);
  }

  function ineligible(args: { threadId: string; status: string; chain: string }) {
    if (held.has(args.threadId)) return "held";
    if (skipped.get(args.threadId) === args.chain) return "cancelled";
    if (args.status !== "error") return `thread-${args.status}`;
    const current = currentChain.get(args.threadId);
    if (current === undefined) return "unknown";
    if (current !== args.chain) return "superseded";
    return null;
  }

  function refresh(threadId: string) {
    if (refreshing.has(threadId)) return;
    refreshing.add(threadId);
    const started = generation.get(threadId) ?? 0;
    void (async () => {
      try {
        const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
        if (thread.status === "error") await loadFailedTurn(thread);
        else currentChain.delete(threadId);
        await bb.experimental_hooks.recheck("message.dispatch");
      } catch (error) {
        bb.log.warn(`Could not read the failed turn of ${threadId}: ${String(error)}`);
      } finally {
        refreshing.delete(threadId);
        if ((generation.get(threadId) ?? 0) !== started && !currentChain.has(threadId))
          refresh(threadId);
      }
    })();
  }

  async function deleteOwnRows(rows: QueueRow[], why: string) {
    let removed = 0;
    for (const row of rows) {
      selfDeleting.add(row.id);
      try {
        await bb.sdk.threads.queuedMessages.delete({
          threadId: row.threadId,
          queuedMessageId: row.id,
        });
        removed += 1;
        bb.log.info(`Withdrew automatic retry ${row.id} on ${row.threadId}: ${why}.`);
      } catch (error) {
        bb.log.warn(`Could not withdraw retry ${row.id} on ${row.threadId}: ${String(error)}`);
      } finally {
        selfDeleting.delete(row.id);
      }
    }
    return removed;
  }

  async function withdrawThreadRows(threadId: string, why: string, chain?: string) {
    const record = workflowsSeen.get(threadId);
    const rows = (await bb.sdk.threads.queue.list({ threadId })).filter(
      (row) =>
        row.state !== "claimed" &&
        ((isOwnRetryRow(row) &&
          (chain === undefined || row.payload.retryOfTurnRequestId === chain)) ||
          (isWorkflowRow(row) &&
            (chain === undefined ||
              (record !== undefined &&
                record.asked.some((id) => record.origins[id]!.chain === chain))))),
    );
    if (rows.length > 0) await deleteOwnRows(rows, why);
  }

  async function removeStaleOwnRows(rows: QueueRow[]) {
    let removed = 0;
    for (const row of rows) {
      if (!isOwnRetryRow(row) || row.state === "claimed") continue;
      const thread = (await bb.sdk.threads.get({
        threadId: row.threadId,
      })) as unknown as ThreadState;
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (thread.status === "error") await loadFailedTurn(thread);
      const why = ineligible({
        threadId: row.threadId,
        status: thread.status,
        chain: row.payload.retryOfTurnRequestId,
      });
      if (why !== null && why !== "unknown") removed += await deleteOwnRows([row], why);
    }
    return removed;
  }

  async function doScan() {
    const at = now();
    const report: ScanReport = {
      at,
      enabled: options.enabled(),
      armed,
      errorThreads: 0,
      entries: [],
      probes: {},
      staleRowsRemoved: 0,
    };
    if (!report.enabled && !options.workflowRecovery()) return report;

    const queuedBefore = await bb.sdk.threads.queue.list({});
    if (armed) report.staleRowsRemoved = await removeStaleOwnRows(queuedBefore);
    const queued =
      report.staleRowsRemoved === 0 ? queuedBefore : await bb.sdk.threads.queue.list({});

    const listed = await listThreads();
    if (options.workflowRecovery()) await checkWorkflows(listed, report);
    if (!report.enabled) return report;
    const threads = listed.filter((thread) => thread.status === "error");
    report.errorThreads = threads.length;
    const errorIds = new Set(threads.map((thread) => thread.id));
    for (const id of failedTurns.keys()) if (!errorIds.has(id)) failedTurns.delete(id);

    const withRetryRow = new Set(
      queued.filter((row) => row.payload.kind === "retry").map((row) => row.threadId),
    );
    const candidates: Array<{ thread: ThreadRow; failed: FailedTurn; entry: ScanEntry }> = [];

    for (const thread of threads) {
      const skip = (reason: string, requestId: string | null = null) =>
        report.entries.push({ threadId: thread.id, requestId, state: "skipped", reason });
      if (thread.originPluginId === WORKFLOW_ENGINE_PLUGIN_ID) {
        skip("workflow-engine-owned");
        continue;
      }
      const failed = await loadFailedTurn(thread);
      if (failed === null) {
        skip("no-failed-turn");
        continue;
      }
      if (failed.failure.kind !== "transport") {
        skip(failed.failure.reason, failed.requestId);
        continue;
      }
      const entry: ScanEntry = {
        threadId: thread.id,
        requestId: failed.requestId,
        state: "skipped",
        reason: "",
        openBackgroundTasks: openBackgroundTasks(thread),
      };
      report.entries.push(entry);
      if (held.has(thread.id)) entry.reason = "held";
      else if (skipped.get(thread.id) === failed.originalRequestId) entry.reason = "cancelled";
      else if (thread.hasPendingInteraction) entry.reason = "pending-interaction";
      else if (withRetryRow.has(thread.id)) entry.reason = "retry-queued";
      if (entry.reason !== "") {
        await record(entry, at);
        continue;
      }
      candidates.push({ thread, failed, entry });
    }

    if (!armed) {
      for (const { entry } of candidates) {
        entry.state = "waiting";
        entry.reason = `not-armed (run: bb provider-retry-advanced arm)`;
      }
      return report;
    }

    const targets = new Set<ProbeTargetId>();
    for (const { failed } of candidates) {
      if (failed.failure.kind === "transport" && failed.failure.route.kind === "provider") {
        targets.add(failed.failure.route.target);
      }
    }
    for (const target of targets) report.probes[target] = await options.probe(target);

    for (const { thread, failed, entry } of candidates) {
      const route = failed.failure.kind === "transport" ? failed.failure.route : null;
      const probe = route?.kind === "provider" ? report.probes[route.target] : undefined;
      if (route?.kind === "provider" && probe?.reachable !== true) {
        entry.state = "waiting";
        entry.reason = `waiting-for-connectivity (${route.target}: ${probe?.detail ?? "not probed"})`;
        await record(entry, at);
        continue;
      }
      entry.reason = await resume(thread.id, failed);
      entry.state = entry.reason === "resumed" ? "resumed" : "skipped";
      await record(entry, at);
    }
    return report;
  }

  async function resume(threadId: string, failed: FailedTurn) {
    const current = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
    if (current.archivedAt !== null || current.deletedAt !== null) return "state-changed:archived";
    if (current.status !== "error") return `state-changed:${current.status}`;
    if ((await bb.sdk.threads.interactions.list({ threadId })).length > 0)
      return "pending-interaction";
    if (!armed) return "not-armed";
    const why = ineligible({ threadId, status: current.status, chain: failed.originalRequestId });
    if (why !== null) return why;
    inflight.set(threadId, failed.originalRequestId);
    try {
      await bb.sdk.threads.retry({
        threadId,
        turnRequestId: failed.requestId,
        reason: TRANSPORT_RETRY_REASON,
      });
      bb.log.info(`Connectivity restored: resumed ${threadId} (${failed.requestId}).`);
      return "resumed";
    } catch (error) {
      const { status, code } = errorStatus(error);
      if (status === 409) return `core:${code ?? "conflict"}`;
      bb.log.warn(`Connectivity retry failed for ${threadId}: ${String(error)}`);
      return `retry-error:${code ?? status ?? "unknown"}`;
    } finally {
      inflight.delete(threadId);
    }
  }

  async function setSkip(threadId: string, chain: string) {
    skipped.set(threadId, chain);
    await bb.storage.kv.set(`skip:${threadId}`, {
      originalRequestId: chain,
      at: now(),
    } satisfies SkipRecord);
  }

  const recovery: TransportRecovery = {
    async init() {
      armed = (await bb.storage.kv.get(ARMED_KEY)) !== undefined;
      for (const key of await bb.storage.kv.list("hold:")) held.add(key.slice("hold:".length));
      for (const key of await bb.storage.kv.list("workflow:")) {
        const record = await bb.storage.kv.get<WorkflowRecord>(key);
        if (record !== undefined) workflowsSeen.set(key.slice("workflow:".length), record);
      }
      for (const key of await bb.storage.kv.list("skip:")) {
        const record = await bb.storage.kv.get<SkipRecord>(key);
        if (record !== undefined) skipped.set(key.slice("skip:".length), record.originalRequestId);
      }
    },
    scan() {
      running ??= doScan()
        .then((report) => {
          last = report;
          return report;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
    lastReport: () => last,
    isArmed: () => armed,
    async arm() {
      if (!armed) {
        await bb.storage.kv.set(ARMED_KEY, { at: now() });
        armed = true;
        await bb.experimental_hooks.recheck("message.dispatch");
      }
      await running;
      return recovery.scan();
    },
    async hold(threadId) {
      held.add(threadId);
      await bb.storage.kv.set(`hold:${threadId}`, { at: now() });
      await forgetWorkflow(threadId);
      await withdrawThreadRows(threadId, "held");
    },
    async release(threadId) {
      held.delete(threadId);
      skipped.delete(threadId);
      await bb.storage.kv.delete(`hold:${threadId}`);
      await bb.storage.kv.delete(`skip:${threadId}`);
    },
    isHeld: (threadId) => held.has(threadId),
    async skipCurrentFailure(threadId) {
      const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
      if (thread.status !== "error") return null;
      const failed = await loadFailedTurn(thread);
      if (failed === null) return null;
      await setSkip(threadId, failed.originalRequestId);
      await withdrawThreadRows(threadId, "cancelled", failed.originalRequestId);
      return failed.originalRequestId;
    },
    noteFailure(threadId) {
      generation.set(threadId, (generation.get(threadId) ?? 0) + 1);
      failedTurns.delete(threadId);
      currentChain.delete(threadId);
      refresh(threadId);
    },
    async onRetryRowCancelled(entry) {
      if (selfDeleting.has(entry.id)) return;
      if (isWorkflowRow(entry as QueueRow)) return forgetWorkflow(entry.threadId);
      if (entry.payload.kind !== "retry" || entry.payload.retryOfTurnRequestId === undefined)
        return;
      await setSkip(entry.threadId, entry.payload.retryOfTurnRequestId);
    },
    decideDispatch(context) {
      const threadId = context.thread.id;
      const workflowRows = context.queuedMessages.filter(isWorkflowRow);
      if (
        workflowRows.length > 0 ||
        (context.queuedMessages.length === 0 && context.input.text.startsWith(WORKFLOW_TAG))
      ) {
        const blocked = workflowBlocked(threadId);
        const checkedAt = workflowReady.get(threadId);
        workflowReady.delete(threadId);
        if (workflowRows.length === 0) {
          if (blocked !== null)
            return {
              action: "reject",
              message: `Interrupted-workflow message withdrawn: ${blocked}.`,
            };
          if (context.thread.status !== "idle")
            return {
              action: "reject",
              message: `Interrupted-workflow message withdrawn: thread-${context.thread.status}.`,
            };
          if (checkedAt === undefined)
            return {
              action: "reject",
              message: "Interrupted-workflow message withdrawn: not-checked.",
            };
          return listEvents(bb, { threadId, afterSeq: checkedAt, order: "asc", limit: 1 }).then(
            ([next]) =>
              next === undefined
                ? { action: "proceed" }
                : {
                    action: "reject",
                    message: "Interrupted-workflow message withdrawn: the thread moved on.",
                  },
          );
        }
        if (blocked !== null) {
          // WARNING: delete these rows after the hook returns, outside core's admission lock.
          setTimeout(() => {
            void deleteOwnRows(workflowRows, blocked).then(() =>
              bb.experimental_hooks.recheck("message.dispatch"),
            );
          }, 0);
          return { action: "wait", reason: `Interrupted-workflow message withdrawn: ${blocked}` };
        }
        if (checkedAt === undefined) {
          refreshWorkflow(threadId);
          return {
            action: "wait",
            reason: "Checking the interrupted workflow",
            sendAt: now() + NOT_READY_WAIT_MS,
          };
        }
        return listEvents(bb, { threadId, afterSeq: checkedAt, order: "asc", limit: 1 }).then(
          ([next]) => {
            if (next === undefined) return { action: "proceed" };
            refreshWorkflow(threadId);
            return {
              action: "wait",
              reason: "Checking the interrupted workflow",
              sendAt: now() + NOT_READY_WAIT_MS,
            };
          },
        );
      }
      const own = context.queuedMessages.filter(isOwnRetryRow);
      if (own.length === 0) {
        const chain = inflight.get(threadId);
        if (chain === undefined || context.queuedMessages.length > 0) return { action: "proceed" };
        const why = ineligible({ threadId, status: context.thread.status, chain });
        return why === null
          ? { action: "proceed" }
          : { action: "reject", message: `Automatic retry withdrawn: ${why}.` };
      }
      if (!armed) return { action: "wait", reason: "Waiting for bb provider-retry-advanced arm" };
      const verdicts = own.map((row) => ({
        row,
        why: ineligible({
          threadId,
          status: context.thread.status,
          chain: row.payload.retryOfTurnRequestId,
        }),
      }));
      if (verdicts.some((v) => v.why === "unknown")) {
        refresh(threadId);
        return {
          action: "wait",
          reason: "Checking the failed turn",
          sendAt: now() + NOT_READY_WAIT_MS,
        };
      }
      const blocked = verdicts.filter((v) => v.why !== null).map((v) => v.row);
      if (blocked.length === 0) return { action: "proceed" };
      const why = verdicts.find((v) => v.why !== null)!.why;
      // WARNING: delete these rows after the hook returns, outside core's admission lock.
      setTimeout(() => {
        void deleteOwnRows(blocked, why ?? "withdrawn").then(() =>
          bb.experimental_hooks.recheck("message.dispatch"),
        );
      }, 0);
      return { action: "wait", reason: `Automatic retry withdrawn: ${why}` };
    },
  };
  return recovery;
}

/** Sleeps for `ms` or until `signal` aborts, whichever comes first. */
export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Scans at startup/reload, then again SCAN_INTERVAL_MS after each scan ends,
 * until disposal. The delay is fixed: neither failed probes nor repeated
 * failures stretch it.
 */
export async function runRecoveryLoop(args: {
  recovery: TransportRecovery;
  signal: AbortSignal;
  log: BbPluginApi["log"];
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const wait = args.wait ?? sleep;
  while (!args.signal.aborted) {
    try {
      await args.recovery.scan();
    } catch (error) {
      args.log.warn(`Connectivity recovery scan failed: ${String(error)}`);
    }
    await wait(SCAN_INTERVAL_MS, args.signal);
  }
}
