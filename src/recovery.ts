import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { RetryDiagnostic } from "./diagnostics.js";
import type { ProbeFn, ProbeResult } from "./probe.js";
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

/** Reasons of every retry row this plugin creates (the stock policy's two, plus its own). */
const OWN_RETRY_REASONS = new Set([TRANSPORT_RETRY_REASON, "Rate limited", "Provider overloaded"]);

/**
 * Set by `arm`. A fresh install observes only until then, so holds can be
 * placed before anything is retried; reloads and restarts keep it.
 */
const ARMED_KEY = "armed";

/** BB Workflows owns its hidden workers' retries, replay and cleanup. */
const WORKFLOW_ENGINE_PLUGIN_ID = "workflows";

const LIST_PAGE_SIZE = 200;

/** How long a drain waits while this plugin has not yet read state after loading. */
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
  /** The latest completion/interruption after the request when this was read. */
  terminalSeq: number | null;
  requestId: string;
  originalRequestId: string;
  failure: FailureClass;
}

/** `threads.get` fields this plugin reads. */
interface ThreadState {
  id: string;
  status: string;
  providerId: string;
  archivedAt: number | null;
  deletedAt: number | null;
}

/** `threads.list` rows additionally carry pending-interaction and background state. */
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

interface SkipRecord {
  originalRequestId: string;
  at: number;
}

export interface TransportRecoveryOptions {
  probe: ProbeFn;
  enabled: () => boolean;
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
  onRetryRowCancelled(entry: { id: string; threadId: string; payload: { kind: string; retryOfTurnRequestId?: string } }): Promise<void>;
  /** The `message.dispatch` checkpoint: core asks before every attempt and every drain. */
  decideDispatch(context: MessageDispatchHookContext): DispatchDecision;
}

function openBackgroundTasks(thread: ThreadRow): number {
  const activity = thread.activity;
  if (activity === undefined) return 0;
  return (
    activity.activeWorkflowCount +
    activity.activeBackgroundAgentCount +
    activity.activeBackgroundCommandCount
  );
}

function errorStatus(error: unknown): { status: number | null; code: string | null } {
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

export function createTransportRecovery(
  bb: BbPluginApi,
  options: TransportRecoveryOptions,
): TransportRecovery {
  const now = options.now ?? Date.now;
  const failedTurns = new Map<string, FailedTurn>();
  const recorded = new Map<string, string>();
  // Mirrors of the KV state, so the dispatch hook decides without I/O.
  const held = new Set<string>();
  const skipped = new Map<string, string>();
  let armed = false;
  // Runtime facts the hook needs: each failed thread's current failed chain
  // (read from its events; unknown until read), and the retries this plugin
  // is submitting inline right now.
  const currentChain = new Map<string, string>();
  // Bumped by every new failure of a thread. A read that started under an older
  // generation never publishes: a newer failure may have moved the chain.
  const generation = new Map<string, number>();
  const refreshing = new Set<string>();
  const inflight = new Map<string, string>();
  const selfDeleting = new Set<string>();
  let running: Promise<ScanReport> | null = null;
  let last: ScanReport | null = null;

  async function listErrorThreads(): Promise<ThreadRow[]> {
    const rows: ThreadRow[] = [];
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const page = (await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit: LIST_PAGE_SIZE,
        offset,
      })) as unknown as ThreadRow[];
      rows.push(...page.filter((thread) => thread.status === "error"));
      if (page.length < LIST_PAGE_SIZE) return rows;
    }
  }

  async function firstEvent(args: {
    threadId: string;
    types: [string, ...string[]];
    afterSeq: number;
    beforeSeq?: number;
    order: "asc" | "desc";
  }): Promise<EventLike | undefined> {
    const [event] = await bb.sdk.threads.events.list({
      threadId: args.threadId,
      types: args.types as never,
      afterSeq: String(args.afterSeq),
      ...(args.beforeSeq === undefined ? {} : { beforeSeq: String(args.beforeSeq) }),
      order: args.order,
      limit: "1",
    });
    return event;
  }

  async function loadFailedTurn(thread: ThreadState): Promise<FailedTurn | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = generation.get(thread.id) ?? 0;
      const read = await readFailedTurn(thread);
      if ((generation.get(thread.id) ?? 0) !== started) continue; // a newer failure landed mid-read
      if (read === null) return null;
      currentChain.set(thread.id, read.originalRequestId);
      if (read.failure.kind !== "other" || read.failure.reason !== "incomplete") failedTurns.set(thread.id, read);
      return read;
    }
    return null; // still changing: stay unknown, the next read or scan decides
  }

  /**
   * The thread's most recent request (the only one core will retry) and the
   * failure that put the thread in `error`. One request can span several
   * provider turns: Claude Code continues on its own when a background task
   * reports, without a new client request. So the terminal event is the
   * LATEST `turn/completed` or `system/thread/interrupted` after the request;
   * if that latest turn did not fail, there is no failure to recover. The
   * decisive error is the last `provider/error` inside that failed provider
   * turn (after the previous completion). Cached per request AND terminal
   * event, so a later provider turn under the same request is read afresh.
   */
  async function readFailedTurn(thread: ThreadState): Promise<FailedTurn | null> {
    const [request] = await bb.sdk.threads.events.list({
      threadId: thread.id,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
    });
    if (request === undefined) return null;
    const latest = (type: string, beforeSeq?: number) =>
      firstEvent({ threadId: thread.id, types: [type], afterSeq: request.seq, ...(beforeSeq === undefined ? {} : { beforeSeq }), order: "desc" });
    const completion = await latest("turn/completed");
    const interrupted = await latest("system/thread/interrupted");
    const terminal = [completion, interrupted]
      .filter((event): event is EventLike => event !== undefined)
      .sort((a, b) => b.seq - a.seq)[0];
    const cached = failedTurns.get(thread.id);
    if (cached !== undefined && cached.requestSeq === request.seq && cached.terminalSeq === (terminal?.seq ?? null)) {
      return cached;
    }
    const data = request.data as { requestId: string; retryOfRequestId?: string };
    const base = {
      requestSeq: request.seq,
      terminalSeq: terminal?.seq ?? null,
      requestId: data.requestId,
      originalRequestId: data.retryOfRequestId ?? data.requestId,
    };
    if (terminal === undefined) return { ...base, failure: { kind: "other", reason: "incomplete" } };
    if (terminal.type === "turn/completed" && (terminal.data as { status?: unknown }).status !== "failed") {
      return { ...base, failure: { kind: "other", reason: `latest-turn-${String((terminal.data as { status?: unknown }).status)}` } };
    }
    if (terminal.type === "system/thread/interrupted") {
      return { ...base, failure: classifyFailedTurn({ providerId: thread.providerId, events: [terminal] }) };
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
    return { ...base, failure: classifyFailedTurn({ providerId: thread.providerId, events }) };
  }

  /** Writes the explain diagnostic only when this thread's decision changed. */
  async function record(entry: ScanEntry, at: number): Promise<void> {
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

  /**
   * Why an automatic retry of `chain` on this thread must not run now, or
   * null. A retry belongs to the failed turn chain it was queued for; when the
   * thread's current failed chain is another one, a later turn superseded it.
   * `unknown` means the current chain has not been read yet: wait, never run.
   */
  function ineligible(args: { threadId: string; status: string; chain: string }): string | null {
    if (held.has(args.threadId)) return "held";
    if (skipped.get(args.threadId) === args.chain) return "cancelled";
    if (args.status !== "error") return `thread-${args.status}`;
    const current = currentChain.get(args.threadId);
    if (current === undefined) return "unknown";
    if (current !== args.chain) return "superseded";
    return null;
  }

  /** Reads the thread's current failed chain, then asks core to re-run the hook. */
  function refresh(threadId: string): void {
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
        // A failure that arrived while this read ran skipped its own refresh.
        if ((generation.get(threadId) ?? 0) !== started && !currentChain.has(threadId)) refresh(threadId);
      }
    })();
  }

  async function deleteOwnRows(rows: QueueRow[], why: string): Promise<number> {
    let removed = 0;
    for (const row of rows) {
      selfDeleting.add(row.id);
      try {
        await bb.sdk.threads.queuedMessages.delete({ threadId: row.threadId, queuedMessageId: row.id });
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

  async function withdrawThreadRows(threadId: string, why: string, chain?: string): Promise<void> {
    const rows = (await bb.sdk.threads.queue.list({ threadId })).filter(
      (row) => isOwnRetryRow(row) && row.state !== "claimed" && (chain === undefined || row.payload.retryOfTurnRequestId === chain),
    );
    if (rows.length > 0) await deleteOwnRows(rows, why);
  }

  /**
   * Withdraws this plugin's own retry rows that must no longer run: the
   * thread is held, the failure was cancelled, the thread is no longer failed
   * (stopped, answered, recovered), or it failed again on a different turn.
   * The dispatch hook already blocks such rows at drain time; this removes
   * them from the queue card. Rows from other plugins or users are never touched.
   */
  async function removeStaleOwnRows(rows: QueueRow[]): Promise<number> {
    let removed = 0;
    for (const row of rows) {
      if (!isOwnRetryRow(row) || row.state === "claimed") continue;
      const thread = (await bb.sdk.threads.get({ threadId: row.threadId })) as unknown as ThreadState;
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue; // core drops these rows
      if (thread.status === "error") await loadFailedTurn(thread);
      const why = ineligible({ threadId: row.threadId, status: thread.status, chain: row.payload.retryOfTurnRequestId });
      if (why !== null && why !== "unknown") removed += await deleteOwnRows([row], why);
    }
    return removed;
  }

  async function doScan(): Promise<ScanReport> {
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
    if (!report.enabled) return report;

    const queuedBefore = await bb.sdk.threads.queue.list({});
    // Before arm, rows are kept as they are (the hook holds them); after, stale ones go.
    if (armed) report.staleRowsRemoved = await removeStaleOwnRows(queuedBefore);
    const queued = report.staleRowsRemoved === 0 ? queuedBefore : await bb.sdk.threads.queue.list({});

    const { total } = await bb.sdk.threads.count({ status: "error" });
    if (total === 0) {
      failedTurns.clear();
      return report;
    }
    const threads = await listErrorThreads();
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

    // Until armed after a fresh install, report what would be resumed and stop:
    // no probe, no retry. This lets the operator hold threads first.
    if (!armed) {
      for (const { entry } of candidates) {
        entry.state = "waiting";
        entry.reason = `not-armed (run: bb provider-retry-advanced arm)`;
      }
      return report;
    }

    // Probe only the provider paths a waiting turn needs, once per scan.
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

  /**
   * Re-reads the thread, then asks core to retry. The re-read and the call
   * are separate operations; what keeps a late change from running the turn
   * is the dispatch hook, which core consults under its admission lock before
   * the attempt reaches the provider (see decideDispatch). Inside the retry
   * core also enforces archive/delete/stopping, the failed turn and dedupe.
   */
  async function resume(threadId: string, failed: FailedTurn): Promise<string> {
    const current = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
    if (current.archivedAt !== null || current.deletedAt !== null) return "state-changed:archived";
    if (current.status !== "error") return `state-changed:${current.status}`;
    if ((await bb.sdk.threads.interactions.list({ threadId })).length > 0) return "pending-interaction";
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

  async function setSkip(threadId: string, chain: string): Promise<void> {
    skipped.set(threadId, chain);
    await bb.storage.kv.set(`skip:${threadId}`, { originalRequestId: chain, at: now() } satisfies SkipRecord);
  }

  const recovery: TransportRecovery = {
    async init() {
      armed = (await bb.storage.kv.get(ARMED_KEY)) !== undefined;
      for (const key of await bb.storage.kv.list("hold:")) held.add(key.slice("hold:".length));
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
      // A new failure moves the thread's failed chain; it is unknown until read.
      generation.set(threadId, (generation.get(threadId) ?? 0) + 1);
      failedTurns.delete(threadId);
      currentChain.delete(threadId);
      refresh(threadId);
    },
    async onRetryRowCancelled(entry) {
      if (selfDeleting.has(entry.id)) return;
      if (entry.payload.kind !== "retry" || entry.payload.retryOfTurnRequestId === undefined) return;
      await setSkip(entry.threadId, entry.payload.retryOfTurnRequestId);
    },
    decideDispatch(context) {
      const threadId = context.thread.id;
      const own = context.queuedMessages.filter(isOwnRetryRow);
      if (own.length === 0) {
        // Inline: only this plugin's own retry call, identified while it runs.
        const chain = inflight.get(threadId);
        if (chain === undefined || context.queuedMessages.length > 0) return { action: "proceed" };
        const why = ineligible({ threadId, status: context.thread.status, chain });
        return why === null
          ? { action: "proceed" }
          : { action: "reject", message: `Automatic retry withdrawn: ${why}.` };
      }
      // Before arm, automatic retries this plugin would own (including rows left
      // by the bundled plugin) wait untouched; `arm` asks core to re-run this.
      if (!armed) return { action: "wait", reason: "Waiting for bb provider-retry-advanced arm" };
      const verdicts = own.map((row) => ({
        row,
        why: ineligible({ threadId, status: context.thread.status, chain: row.payload.retryOfTurnRequestId }),
      }));
      if (verdicts.some((v) => v.why === "unknown")) {
        refresh(threadId);
        return { action: "wait", reason: "Checking the failed turn", sendAt: now() + NOT_READY_WAIT_MS };
      }
      const blocked = verdicts.filter((v) => v.why !== null).map((v) => v.row);
      if (blocked.length === 0) return { action: "proceed" };
      const why = verdicts.find((v) => v.why !== null)!.why;
      // Hold the attempt, then take the rows off the queue outside the hook's
      // lock; anything else grouped with them is re-attempted afterwards.
      setTimeout(() => {
        void deleteOwnRows(blocked, why ?? "withdrawn").then(() => bb.experimental_hooks.recheck("message.dispatch"));
      }, 0);
      return { action: "wait", reason: `Automatic retry withdrawn: ${why}` };
    },
  };
  return recovery;
}

/** Sleeps for `ms` or until `signal` aborts, whichever comes first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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
}): Promise<void> {
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
