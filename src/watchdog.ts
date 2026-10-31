import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RetryDiagnostic } from "./diagnostics.js";
import {
  hasPendingInteraction,
  isOwnMessage,
  latestRequest,
  listEvents,
  openBackgroundWork,
  openToolItems,
  sendAgentOnly,
  stallText,
  type Execution,
} from "./continuations.js";

/** How often the watchdog looks at running turns. */
export const WATCHDOG_INTERVAL_MS = 60_000;

/** The wall clock ran this far ahead of the monotonic clock between two checks: the Mac slept. */
const SLEEP_GAP_MS = 60_000;

/** No check for this long means the process was suspended, whatever the clocks say. */
const MAX_CHECK_GAP_MS = 10 * 60_000;

/** How long to wait for a stop to settle before leaving the continue to a later check. */
const STOP_SETTLE_MS = 30_000;
const STOP_POLL_MS = 1_000;

/** A stop whose continue could not be sent yet is retried by later checks for this long. */
const PENDING_CONTINUE_MS = 10 * 60_000;

/** Restart records are kept this long; a turn that stalls again later is a new stall. */
const RECORD_TTL_MS = 2 * 24 * 60 * 60_000;

/** BB Workflows owns its hidden workers; their stalls are the engine's to handle. */
const WORKFLOW_ENGINE_PLUGIN_ID = "workflows";

export const STALL_RETRY_REASON = "Stalled turn restarted";

export type StallEntryState = "restarted" | "skipped";

export interface StallEntry {
  threadId: string;
  requestId: string | null;
  state: StallEntryState;
  reason: string;
  /** Minutes without a new event while BB was awake. */
  quietMinutes: number;
}

export interface WatchdogReport {
  at: number;
  /** Minutes without events after which a turn counts as stalled; null when the watchdog is off. */
  limitMinutes: number | null;
  armed: boolean;
  /** Quiet time is counted from here at the earliest: plugin start or the last wake from sleep. */
  countingSince: number;
  running: number;
  /** Only turns quiet for at least the limit, or acted on. */
  entries: StallEntry[];
}

interface StallRecord {
  /** The request whose turn stalled; it is restarted once. */
  requestId: string;
  stoppedAt: number;
  continued: boolean;
  minutes: number;
  execution: Execution | null;
}

export interface StallWatchdogOptions {
  /** Milliseconds without events that count as a stall, or null when off. */
  limitMs: () => number | null;
  isArmed: () => boolean;
  isHeld: (threadId: string) => boolean;
  now: () => number;
  /** A clock that does not advance while the machine sleeps. */
  monotonic: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface StallWatchdog {
  init(): Promise<void>;
  /** One check; concurrent callers share the check already running. */
  check(): Promise<WatchdogReport>;
  lastReport(): WatchdogReport | null;
}

interface ThreadState {
  id: string;
  status: string;
  originPluginId: string | null;
  activeBackgroundAgentCount?: number;
}

export function createStallWatchdog(bb: BbPluginApi, options: StallWatchdogOptions): StallWatchdog {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastWall = options.now();
  let lastMono = options.monotonic();
  let countingSince = lastWall;
  const records = new Map<string, StallRecord>();
  let running: Promise<WatchdogReport> | null = null;
  let last: WatchdogReport | null = null;

  /**
   * Quiet time only counts while BB is awake. A sleeping Mac produces no
   * events and runs no checks, so after a wake every running turn looks
   * silent for hours; counting restarts at the wake instead.
   */
  function observeClock(): void {
    const wall = options.now();
    const mono = options.monotonic();
    const wallGap = wall - lastWall;
    if (wallGap - (mono - lastMono) > SLEEP_GAP_MS || wallGap > MAX_CHECK_GAP_MS) {
      countingSince = wall;
      bb.log.info(`Stall watchdog: BB was asleep or suspended for about ${Math.round(wallGap / 60_000)} min; counting quiet time from now.`);
    }
    lastWall = wall;
    lastMono = mono;
  }

  async function saveRecord(threadId: string, record: StallRecord): Promise<void> {
    records.set(threadId, record);
    await bb.storage.kv.set(`stall:${threadId}`, record);
  }

  async function diagnose(threadId: string, requestId: string, at: number): Promise<void> {
    const diagnostic: RetryDiagnostic = {
      requestId,
      observedAt: at,
      availability: { kind: "not-routed" },
      decision: { kind: "retry", reason: STALL_RETRY_REASON, sendAt: at },
    };
    await bb.storage.kv.set(`decision:${threadId}`, diagnostic);
  }

  /** Sends the one continue for a stopped turn once the thread is idle; returns what happened. */
  async function sendContinue(threadId: string, record: StallRecord): Promise<string> {
    const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
    if (thread.status === "stopping" || thread.status === "active" || thread.status === "starting" || thread.status === "pending") {
      return "stop-not-settled";
    }
    // Failed while stopping: the connectivity scan and the stock policy own a failed thread.
    if (thread.status !== "idle") {
      await saveRecord(threadId, { ...record, continued: true });
      return `stopped:${thread.status}`;
    }
    // A message that ran after the stop already moved the thread on.
    if ((await latestRequest(bb, threadId))?.requestId !== record.requestId) {
      await saveRecord(threadId, { ...record, continued: true });
      return "stopped:thread-moved-on";
    }
    // Work queued on the thread runs now that it is idle and continues it anyway.
    if ((await bb.sdk.threads.queue.list({ threadId })).length > 0) {
      await saveRecord(threadId, { ...record, continued: true });
      return "stopped:queued-message-continues";
    }
    await sendAgentOnly(bb, { threadId, text: stallText(record.minutes), execution: record.execution });
    await saveRecord(threadId, { ...record, continued: true });
    bb.log.info(`Stall watchdog: sent one continue to ${threadId} for stalled turn ${record.requestId}.`);
    return "restarted";
  }

  async function settle(threadId: string): Promise<void> {
    for (let waited = 0; waited < STOP_SETTLE_MS; waited += STOP_POLL_MS) {
      const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
      if (thread.status !== "stopping" && thread.status !== "active") return;
      await wait(STOP_POLL_MS);
    }
  }

  async function quietSince(threadId: string): Promise<{ at: number; seq: number }> {
    const [latest] = await listEvents(bb, { threadId, order: "desc", limit: 1 });
    return { at: Math.max(latest?.createdAt ?? 0, countingSince), seq: latest?.seq ?? 0 };
  }

  /** Why this quiet running turn must be left alone, or null when it may be restarted. */
  async function leaveAlone(thread: ThreadState, afterSeq: number): Promise<string | null> {
    if (thread.status !== "active") return `thread-${thread.status}`;
    if (options.isHeld(thread.id)) return "held";
    if (thread.originPluginId === WORKFLOW_ENGINE_PLUGIN_ID) return "workflow-engine-owned";
    if (await hasPendingInteraction(bb, thread.id)) return "waiting-for-user";
    if ((thread.activeBackgroundAgentCount ?? 0) > 0 || (await openBackgroundWork(bb, thread.id)) > 0) return "background-work-open";
    const open = await openToolItems(bb, thread.id, afterSeq);
    if (open.length > 0) return `tool-running:${open[0]}`;
    return null;
  }

  async function inspect(threadId: string, at: number, limitMs: number): Promise<StallEntry | null> {
    const quiet = await quietSince(threadId);
    const quietMs = at - quiet.at;
    if (quietMs < limitMs) return null;
    const entry: StallEntry = { threadId, requestId: null, state: "skipped", reason: "", quietMinutes: Math.floor(quietMs / 60_000) };
    const request = await latestRequest(bb, threadId);
    if (request === null) {
      entry.reason = "no-request";
      return entry;
    }
    entry.requestId = request.requestId;
    if (isOwnMessage(request) || records.get(threadId)?.requestId === request.requestId) {
      entry.reason = "already-restarted-once";
      return entry;
    }
    const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadState;
    const why = await leaveAlone(thread, request.seq);
    if (why !== null) {
      entry.reason = why;
      return entry;
    }
    if (!options.isArmed()) {
      entry.reason = "not-armed (run: bb provider-retry-advanced arm)";
      return entry;
    }
    // The checks above took several reads; act only if nothing moved meanwhile.
    const again = await quietSince(threadId);
    if (again.seq !== quiet.seq || (await hasPendingInteraction(bb, threadId))) {
      entry.reason = "moved-meanwhile";
      return entry;
    }
    const minutes = Math.round(limitMs / 60_000);
    await saveRecord(threadId, { requestId: request.requestId, stoppedAt: at, continued: false, minutes, execution: request.execution });
    bb.log.info(`Stall watchdog: ${threadId} made no progress for ${entry.quietMinutes} min (turn ${request.requestId}); stopping it to restart once.`);
    await bb.sdk.threads.stop({ threadId });
    await settle(threadId);
    entry.reason = await sendContinue(threadId, records.get(threadId)!);
    entry.state = entry.reason === "restarted" ? "restarted" : "skipped";
    await diagnose(threadId, request.requestId, at);
    return entry;
  }

  async function doCheck(): Promise<WatchdogReport> {
    observeClock();
    const at = options.now();
    const limitMs = options.limitMs();
    const report: WatchdogReport = {
      at,
      limitMinutes: limitMs === null ? null : Math.round(limitMs / 60_000),
      armed: options.isArmed(),
      countingSince,
      running: 0,
      entries: [],
    };
    if (limitMs === null) return report;

    // A stop that had not settled at the last check gets its continue now.
    for (const [threadId, record] of records) {
      if (record.continued) continue;
      if (at - record.stoppedAt > PENDING_CONTINUE_MS || options.isHeld(threadId)) {
        await saveRecord(threadId, { ...record, continued: true });
        continue;
      }
      const reason = await sendContinue(threadId, record).catch((error: unknown) => `continue-error:${String(error)}`);
      report.entries.push({ threadId, requestId: record.requestId, state: reason === "restarted" ? "restarted" : "skipped", reason, quietMinutes: 0 });
    }

    const runningThreads = await bb.sdk.threads.listRunning();
    report.running = runningThreads.length;
    for (const { id } of runningThreads) {
      try {
        const entry = await inspect(id, at, limitMs);
        if (entry !== null) report.entries.push(entry);
      } catch (error) {
        bb.log.warn(`Stall watchdog could not check ${id}: ${String(error)}`);
        report.entries.push({ threadId: id, requestId: null, state: "skipped", reason: `error:${String(error)}`, quietMinutes: 0 });
      }
    }
    return report;
  }

  return {
    async init() {
      const at = options.now();
      for (const key of await bb.storage.kv.list("stall:")) {
        const record = await bb.storage.kv.get<StallRecord>(key);
        if (record === undefined) continue;
        if (at - record.stoppedAt > RECORD_TTL_MS) await bb.storage.kv.delete(key);
        else records.set(key.slice("stall:".length), record);
      }
    },
    check() {
      running ??= doCheck()
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
  };
}

/** Checks every WATCHDOG_INTERVAL_MS until disposal. */
export async function runWatchdogLoop(args: {
  watchdog: StallWatchdog;
  signal: AbortSignal;
  log: BbPluginApi["log"];
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  while (!args.signal.aborted) {
    await args.wait(WATCHDOG_INTERVAL_MS, args.signal);
    if (args.signal.aborted) return;
    try {
      await args.watchdog.check();
    } catch (error) {
      args.log.warn(`Stall watchdog check failed: ${String(error)}`);
    }
  }
}
