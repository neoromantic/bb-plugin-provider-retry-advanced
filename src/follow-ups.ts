import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import {
  hasPendingInteraction,
  isAutomaticRetry,
  isOwnMessage,
  latestRequest,
  listEvents,
  NUDGE_TEXT,
  countToolItems,
  openBackgroundWork,
  parseRequest,
  runningChildren,
  requestsAfter,
  sendAgentOnly,
  STALL_TAG,
  UNFINISHED_TAG,
  unfinishedText,
  type Execution,
  type TurnRequest,
} from "./continuations.js";
import { isRateLimitFailure } from "./retry-policy.js";
import { classifyFailedTurn } from "./transport.js";

/** BB Workflows owns its hidden workers. */
const WORKFLOW_ENGINE_PLUGIN_ID = "workflows";

/** An unfinished request older than this is no longer followed up. */
const UNFINISHED_TTL_MS = 24 * 60 * 60_000;

/** Longest final message that still counts as "only a promise to continue". */
const SHORT_REPLY_CHARS = 400;

/**
 * Most tool calls a resumed turn may have made and still count as having
 * stopped at a promise; a turn that did more is treated as real work.
 */
const MAX_TOOLS_BEFORE_PROMISE = 5;

/**
 * A reply that opens with "Продолжу / Продолжаю / I'll continue / Resuming…".
 * Only the opening is matched and only present or future forms, so a real
 * answer ("Готово…", "Продолжили, нашлась проблема…") does not count.
 */
const PROMISE_TO_CONTINUE =
  /^[\s*_>"«-]*(?:(?:ок|ok|okay|хорошо|ладно)[,.!]?\s+)?(?:продолж(?:у|аю|им|аем)(?![а-яё])|возобновл(?:яю|ю)(?![а-яё])|continuing\b|resuming\b|i(?:'ll| will) (?:now )?(?:continue|resume|pick)|let me (?:continue|resume|pick)|picking up)/i;

export function looksLikeOnlyAPromise(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= SHORT_REPLY_CHARS && PROMISE_TO_CONTINUE.test(trimmed);
}

export interface FollowUpEntry {
  at: number;
  threadId: string;
  kind: "continuation" | "unfinished";
  action: "sent" | "skipped" | "tracked" | "dropped";
  reason: string;
}

interface UnfinishedRecord {
  requestId: string;
  originalRequestId: string;
  requestSeq: number;
  failedAt: number;
  automation: boolean;
  accepted: boolean;
  /** The request's text, kept only when the provider never accepted it. */
  input: string;
  execution: Execution | null;
}

/** The `thread.idle` payload fields this module reads. */
export interface IdleThread {
  id: string;
  originPluginId: string | null;
  queuedMessageCount?: number;
  activeBackgroundAgentCount?: number;
}

export interface FollowUpOptions {
  continuationCheck: () => boolean;
  unfinishedFollowUp: () => boolean;
  isArmed: () => boolean;
  isHeld: (threadId: string) => boolean;
  now: () => number;
}

export interface FollowUps {
  init(): Promise<void>;
  /** `turn.failed`: remember a failed request a person or another thread sent, if a retry policy would retry it. */
  noteFailure(event: PluginTurnFailedEvent): Promise<void>;
  /** `thread.idle`: the continuation check and the unfinished-request follow-up. */
  onIdle(thread: IdleThread, lastAssistantText: string | null): Promise<void>;
  recent(threadId?: string): FollowUpEntry[];
  pendingUnfinished(): number;
}

export function createFollowUps(bb: BbPluginApi, options: FollowUpOptions): FollowUps {
  const unfinished = new Map<string, UnfinishedRecord>();
  const nudged = new Map<string, string>();
  const log: FollowUpEntry[] = [];

  function note(entry: Omit<FollowUpEntry, "at">): void {
    log.push({ at: options.now(), ...entry });
    if (log.length > 50) log.shift();
  }

  async function drop(threadId: string, reason: string): Promise<void> {
    unfinished.delete(threadId);
    await bb.storage.kv.delete(`unfinished:${threadId}`);
    note({ threadId, kind: "unfinished", action: "dropped", reason });
  }

  /** Whether the failed request's turn failed for a reason the retry policies handle (connectivity, overload, rate limit). */
  async function retryableFailure(event: PluginTurnFailedEvent, request: TurnRequest): Promise<boolean> {
    if (event.errorInfo?.category === "overloaded" || isRateLimitFailure(event)) return true;
    const thread = (await bb.sdk.threads.get({ threadId: event.threadId })) as unknown as { providerId: string };
    const terminals = await listEvents(bb, {
      threadId: event.threadId,
      types: ["turn/completed", "system/thread/interrupted"],
      afterSeq: request.seq,
      order: "asc",
      limit: 50,
    });
    const terminal = terminals.find(
      (e) => e.type === "system/thread/interrupted" || (e.data as { status?: unknown } | null)?.status === "failed",
    );
    if (terminal === undefined) return false;
    if (terminal.type === "system/thread/interrupted") {
      return classifyFailedTurn({ providerId: thread.providerId, events: [terminal] }).kind === "transport";
    }
    const previous = terminals.filter((e) => e.type === "turn/completed" && e.seq < terminal.seq).at(-1);
    const [decisive] = await listEvents(bb, {
      threadId: event.threadId,
      types: ["provider/error"],
      afterSeq: previous?.seq ?? request.seq,
      beforeSeq: terminal.seq,
      order: "desc",
      limit: 1,
    });
    const events = decisive === undefined ? [terminal] : [decisive, terminal];
    return classifyFailedTurn({ providerId: thread.providerId, events }).kind === "transport";
  }

  /**
   * A failed request whose retry never ran because later system notifications
   * (child threads finishing or failing) took the thread's turn first: core
   * only retries the most recent turn, so the request is silently lost. This
   * sends it back once, when the thread is idle. Returns true when it sent.
   */
  async function followUpUnfinished(thread: IdleThread, record: UnfinishedRecord): Promise<boolean> {
    const threadId = thread.id;
    if (options.now() - record.failedAt > UNFINISHED_TTL_MS) {
      await drop(threadId, "expired");
      return false;
    }
    const after = await requestsAfter(bb, threadId, record.requestSeq);
    if (after.length === 0) {
      await drop(threadId, "nothing-superseded-it");
      return false;
    }
    if (after.some((r) => !isOwnMessage(r) && r.retryOfRequestId === null && (r.initiator === "user" || r.initiator === "agent"))) {
      await drop(threadId, "a-newer-message-took-over");
      return false;
    }
    const chain = after.filter((r) => r.retryOfRequestId === record.originalRequestId);
    const lastAttempt = chain.at(-1);
    if (lastAttempt !== undefined) {
      if (after.at(-1) === lastAttempt) {
        await drop(threadId, "retried");
        return false;
      }
      const [completion] = await listEvents(bb, { threadId, types: ["turn/completed"], afterSeq: lastAttempt.seq, order: "asc", limit: 1 });
      if ((completion?.data as { status?: unknown } | undefined)?.status === "completed") {
        await drop(threadId, "retried");
        return false;
      }
    }
    // Something else will run on the thread first, or it waits for a person: decide on a later idle.
    if ((thread.queuedMessageCount ?? 0) > 0) return false;
    if (await hasPendingInteraction(bb, threadId)) return false;
    if ((thread.activeBackgroundAgentCount ?? 0) > 0 || (await openBackgroundWork(bb, threadId)) > 0) return false;
    unfinished.delete(threadId);
    await bb.storage.kv.delete(`unfinished:${threadId}`);
    await sendAgentOnly(bb, {
      threadId,
      text: unfinishedText({ failedAt: record.failedAt, automation: record.automation, accepted: record.accepted, input: record.input }),
      execution: record.execution,
    });
    note({ threadId, kind: "unfinished", action: "sent", reason: `request ${record.requestId} was superseded by system notifications` });
    bb.log.info(`Unfinished request: ${record.requestId} on ${threadId} failed and was superseded by system notifications; sent it back once.`);
    return true;
  }

  /**
   * After an automatic retry or restart, a turn that ends on a short "I'll
   * continue" after at most a few tool calls gets one more continue. Once per
   * continuation turn; this plugin never answers its own nudge.
   */
  async function checkContinuation(thread: IdleThread, text: string | null): Promise<void> {
    const threadId = thread.id;
    const request = await latestRequest(bb, threadId);
    if (request === null) return;
    const automatic = isAutomaticRetry(request) || request.text.startsWith(STALL_TAG) || request.text.startsWith(UNFINISHED_TAG);
    if (!automatic || nudged.get(threadId) === request.requestId) return;
    if (!looksLikeOnlyAPromise(text)) return;
    const skip = (reason: string) => note({ threadId, kind: "continuation", action: "skipped", reason });
    if ((await countToolItems(bb, threadId, request.seq)) > MAX_TOOLS_BEFORE_PROMISE) return skip("did-real-work");
    if ((thread.queuedMessageCount ?? 0) > 0) return skip("queued-message-continues");
    if (await hasPendingInteraction(bb, threadId)) return skip("waiting-for-user");
    if ((thread.activeBackgroundAgentCount ?? 0) > 0 || (await openBackgroundWork(bb, threadId)) > 0) return skip("background-work-open");
    if ((await runningChildren(bb, threadId)) > 0) return skip("waiting-for-child-threads");
    nudged.set(threadId, request.requestId);
    await bb.storage.kv.set(`nudge:${threadId}`, request.requestId);
    await sendAgentOnly(bb, { threadId, text: NUDGE_TEXT, execution: request.execution });
    note({ threadId, kind: "continuation", action: "sent", reason: `turn ${request.requestId} ended with only a promise to continue` });
    bb.log.info(`Continuation check: ${threadId} ended its resumed turn ${request.requestId} with only a promise to continue; sent one more continue.`);
  }

  return {
    async init() {
      for (const key of await bb.storage.kv.list("unfinished:")) {
        const record = await bb.storage.kv.get<UnfinishedRecord>(key);
        if (record !== undefined) unfinished.set(key.slice("unfinished:".length), record);
      }
      for (const key of await bb.storage.kv.list("nudge:")) {
        const requestId = await bb.storage.kv.get<string>(key);
        if (typeof requestId === "string") nudged.set(key.slice("nudge:".length), requestId);
      }
    },
    async noteFailure(event) {
      if (!options.unfinishedFollowUp()) return;
      // A notification can take the thread's turn within seconds, so look a few requests back.
      const recentRequests = await listEvents(bb, { threadId: event.threadId, types: ["client/turn/requested"], order: "desc", limit: 10 });
      const found = recentRequests.map(parseRequest).find((r) => r.requestId === event.requestId);
      if (found === undefined) return;
      const request = found;
      // Only a request a person, an automation or another thread sent; a retry continues a chain already tracked.
      if (request.retryOfRequestId !== null || request.initiator === "system" || isOwnMessage(request)) return;
      if (unfinished.get(event.threadId)?.originalRequestId === request.requestId) return;
      if (!(await retryableFailure(event, request))) return;
      const record: UnfinishedRecord = {
        requestId: request.requestId,
        originalRequestId: request.requestId,
        requestSeq: request.seq,
        failedAt: request.createdAt || options.now(),
        automation: request.text.startsWith("[bb automation"),
        accepted: event.inputAccepted,
        input: event.inputAccepted ? "" : request.text.slice(0, 20_000),
        execution: request.execution,
      };
      unfinished.set(event.threadId, record);
      await bb.storage.kv.set(`unfinished:${event.threadId}`, record);
      note({ threadId: event.threadId, kind: "unfinished", action: "tracked", reason: `request ${request.requestId} failed` });
    },
    async onIdle(thread, lastAssistantText) {
      const record = unfinished.get(thread.id);
      if (record !== undefined && !options.unfinishedFollowUp()) await drop(thread.id, "setting-off");
      if (!options.isArmed() || options.isHeld(thread.id) || thread.originPluginId === WORKFLOW_ENGINE_PLUGIN_ID) return;
      if (record !== undefined && options.unfinishedFollowUp() && (await followUpUnfinished(thread, record))) return;
      if (options.continuationCheck()) await checkContinuation(thread, lastAssistantText);
    },
    recent: (threadId) => log.filter((entry) => threadId === undefined || entry.threadId === threadId),
    pendingUnfinished: () => unfinished.size,
  };
}
