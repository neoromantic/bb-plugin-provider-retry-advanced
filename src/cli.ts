// Derived from get-bb/bb plugins/provider-retry/src/cli.ts (MIT, desktop-v0.46.1).
// Changes: command name, connectivity recovery, watchdog and follow-up state
// in `status`, `cancel` also stops recovery of the current failure, new
// `hold`, `release`, `scan`, `watchdog`.
import { readRetryDiagnostic } from "./diagnostics.js";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  findQueuedRetry,
  listQueuedRetries,
  type QueuedRetry,
} from "./queued-retries.js";
import type { FollowUpEntry, FollowUps } from "./follow-ups.js";
import type { ScanEntry, ScanReport, TransportRecovery } from "./recovery.js";
import type { StallEntry, StallWatchdog, WatchdogReport } from "./watchdog.js";

export interface CliExtras {
  watchdog: StallWatchdog;
  followUps: FollowUps;
}

export const CLI_NAME = "provider-retry-advanced";

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const THREAD_ID_POSITIONAL = {
  name: "thread-id",
  description: "Thread to act on; defaults to this thread",
} as const;

type ThreadCommand = "cancel" | "retry" | "explain" | "hold" | "release";

function textQueuedRetry(queued: QueuedRetry): string {
  const retry =
    queued.sendAt === null
      ? "pending"
      : `retrying ${new Date(queued.sendAt).toISOString()}`;
  return `${queued.threadId}\t${queued.id}\t${retry}`;
}

function textRecoveryEntry(entry: ScanEntry): string {
  const background =
    entry.openBackgroundTasks !== undefined && entry.openBackgroundTasks > 0
      ? `\t${entry.openBackgroundTasks} background task(s) open`
      : "";
  return `${entry.threadId}\t${entry.state}\t${entry.reason}${background}`;
}

function textStallEntry(entry: StallEntry): string {
  return `${entry.threadId}\t${entry.state}\t${entry.reason}\tquiet ${entry.quietMinutes} min`;
}

function textFollowUp(entry: FollowUpEntry): string {
  return `${entry.threadId}\t${entry.kind}\t${entry.action}\t${entry.reason}\t${new Date(entry.at).toISOString()}`;
}

function watchdogLines(report: WatchdogReport | null, threadId: string | null): string[] {
  if (report === null) return [];
  if (report.limitMinutes === null) return ["Stall watchdog is off (setting stallWatchdog)."];
  const entries = report.entries.filter((entry) => threadId === null || entry.threadId === threadId);
  const head = `Stall watchdog (${report.limitMinutes} min, ${report.running} running, checked ${new Date(report.at).toISOString()})`;
  return entries.length === 0 ? [`${head}: nothing stalled.`] : [`${head}:`, ...entries.map(textStallEntry)];
}

/** Connectivity entries only: other failures belong to their own policies. */
function recoveryEntries(report: ScanReport | null, threadId: string | null): ScanEntry[] {
  return (report?.entries ?? []).filter(
    (entry) =>
      entry.openBackgroundTasks !== undefined &&
      (threadId === null || entry.threadId === threadId),
  );
}

function requiredThreadId(
  requested: string | undefined,
  context: PluginCliContext,
  command: ThreadCommand,
): string {
  const threadId = requested ?? context.threadId;
  if (threadId === undefined) {
    throw new PluginCliError(
      `A thread id is required: bb ${CLI_NAME} ${command} <thread-id>`,
      { code: "missing_thread_id", exitCode: 2 },
    );
  }
  return threadId;
}

function output(json: boolean, value: unknown, text: string): PluginCliResult {
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(value, null, 2)}\n` : text,
  };
}

async function sendNow(
  bb: BbPluginApi,
  threadId: string,
  json: boolean,
): Promise<PluginCliResult> {
  const queued = await findQueuedRetry(bb, threadId);
  if (queued === null) {
    throw new PluginCliError(
      `No pending provider retry exists for ${threadId}.`,
      {
        code: "no_pending_retry",
        hint: `Run \`bb ${CLI_NAME} status\` for the threads with a pending retry.`,
      },
    );
  }
  await bb.sdk.threads.queuedMessages.send({
    threadId: queued.threadId,
    queuedMessageId: queued.id,
    mode: "auto",
  });
  return output(
    json,
    { ok: true, threadId, queuedMessageId: queued.id },
    `Retrying ${threadId} now.\n`,
  );
}

/**
 * Deletes a pending retry row, and stops connectivity recovery of the
 * thread's current failed turn so the next scan does not queue it again.
 * A later, different failure on the thread is eligible again.
 */
async function cancel(
  bb: BbPluginApi,
  recovery: TransportRecovery,
  threadId: string,
  json: boolean,
): Promise<PluginCliResult> {
  const queued = await findQueuedRetry(bb, threadId);
  if (queued !== null) {
    await bb.sdk.threads.queuedMessages.delete({
      threadId: queued.threadId,
      queuedMessageId: queued.id,
    });
  }
  // An unknown or non-failed thread simply has no failure to stop.
  const skipped = await recovery.skipCurrentFailure(threadId).catch(() => null);
  if (queued === null && skipped === null) {
    throw new PluginCliError(
      `No pending provider retry or failed turn exists for ${threadId}.`,
      {
        code: "no_pending_retry",
        hint: `Run \`bb ${CLI_NAME} status\` for the threads with a pending retry.`,
      },
    );
  }
  return output(
    json,
    { ok: true, threadId, queuedMessageId: queued?.id ?? null, cancelledTurnRequestId: skipped },
    `Cancelled provider retry for ${threadId}.\n`,
  );
}

export function registerProviderRetryCli(
  bb: BbPluginApi,
  recovery: TransportRecovery,
  extras: CliExtras,
): void {
  bb.cli.register(
    defineCli({
      name: CLI_NAME,
      summary: "Manage automatic provider and connectivity retries",
      description:
        "A pending retry is an ordinary durable queued row: cancel deletes it, retry sends it now. Turns that failed because the provider or machine was unreachable are resumed once it is reachable again; stalled running turns are stopped and continued once; hold opts a thread out of everything.",
      usageErrorExitCode: 2,
      commands: {
        status: cliCommand({
          summary: "Show pending retries and turns waiting for connectivity",
          positionals: [
            {
              name: "thread-id",
              description:
                "Thread to scope the listing to; defaults to this thread, and lists every thread outside one",
            },
          ],
          options: { json: JSON_OPTION },
          async run(input, context) {
            const threadId =
              input.positionals["thread-id"] ?? context.threadId ?? null;
            const queued = await listQueuedRetries(
              bb,
              threadId === null ? undefined : threadId,
            );
            const report = recovery.lastReport();
            const connectivity = recoveryEntries(report, threadId);
            const watch = extras.watchdog.lastReport();
            const followUps = extras.followUps.recent(threadId ?? undefined);
            const lines = [
              queued.length === 0
                ? "No provider retries are pending."
                : queued.map(textQueuedRetry).join("\n"),
              ...(report === null
                ? []
                : !report.enabled
                  ? ["Connectivity recovery is off (setting transportRecovery)."]
                  : !report.armed
                    ? [`Connectivity recovery is observing only until \`bb ${CLI_NAME} arm\`:`, ...connectivity.map(textRecoveryEntry)]
                  : connectivity.length === 0
                    ? [`Connectivity recovery: nothing waiting (scanned ${new Date(report.at).toISOString()}).`]
                    : [
                        `Connectivity recovery (scanned ${new Date(report.at).toISOString()}):`,
                        ...connectivity.map(textRecoveryEntry),
                      ]),
              ...watchdogLines(watch, threadId),
              ...(followUps.length === 0 ? [] : ["Follow-ups:", ...followUps.map(textFollowUp)]),
            ];
            return output(
              input.options.json,
              {
                retries: queued,
                watchdog:
                  watch === null
                    ? null
                    : { ...watch, entries: watch.entries.filter((entry) => threadId === null || entry.threadId === threadId) },
                followUps: { recent: followUps, pendingUnfinished: extras.followUps.pendingUnfinished() },
                connectivity: report === null
                  ? null
                  : {
                      enabled: report.enabled,
                      armed: report.armed,
                      scannedAt: report.at,
                      probes: report.probes,
                      entries: connectivity,
                    },
              },
              `${lines.join("\n")}\n`,
            );
          },
        }),
        explain: cliCommand({
          summary: "Explain the last automatic retry decision for a thread",
          positionals: [THREAD_ID_POSITIONAL],
          options: { json: JSON_OPTION },
          async run(input, context) {
            const threadId = requiredThreadId(
              input.positionals["thread-id"],
              context,
              "explain",
            );
            const diagnostic = await readRetryDiagnostic(bb, threadId);
            const held = await recovery.isHeld(threadId);
            if (input.options.json)
              return output(true, { threadId, diagnostic, held }, "");
            if (diagnostic === null)
              return output(
                false,
                null,
                `No automatic retry decision recorded for ${threadId}.${held ? " Held." : ""}\n`,
              );
            const { decision, availability } = diagnostic;
            return output(
              false,
              null,
              `${threadId}: ${decision.kind === "retry" ? `Scheduled for ${new Date(decision.sendAt).toISOString()}` : "Skipped"}: ${decision.reason}${availability.kind === "unavailable" ? ` (${availability.reason})` : ""}.${held ? " Held." : ""}\n`,
            );
          },
        }),
        cancel: cliCommand({
          summary: "Cancel a pending retry and stop recovering the current failed turn",
          positionals: [THREAD_ID_POSITIONAL],
          options: { json: JSON_OPTION },
          run: (input, context) =>
            cancel(
              bb,
              recovery,
              requiredThreadId(input.positionals["thread-id"], context, "cancel"),
              input.options.json,
            ),
        }),
        retry: cliCommand({
          summary: "Send a pending provider retry now instead of waiting",
          positionals: [THREAD_ID_POSITIONAL],
          options: { json: JSON_OPTION },
          run: (input, context) =>
            sendNow(
              bb,
              requiredThreadId(input.positionals["thread-id"], context, "retry"),
              input.options.json,
            ),
        }),
        hold: cliCommand({
          summary: "Never retry, restart or follow up this thread automatically",
          positionals: [THREAD_ID_POSITIONAL],
          options: { json: JSON_OPTION },
          async run(input, context) {
            const threadId = requiredThreadId(input.positionals["thread-id"], context, "hold");
            await recovery.hold(threadId);
            return output(input.options.json, { ok: true, threadId, held: true }, `Held ${threadId}.\n`);
          },
        }),
        release: cliCommand({
          summary: "Undo hold and cancel for this thread's connectivity recovery",
          positionals: [THREAD_ID_POSITIONAL],
          options: { json: JSON_OPTION },
          async run(input, context) {
            const threadId = requiredThreadId(input.positionals["thread-id"], context, "release");
            await recovery.release(threadId);
            return output(input.options.json, { ok: true, threadId, held: false }, `Released ${threadId}.\n`);
          },
        }),
        arm: cliCommand({
          summary: "Let connectivity recovery act (once, after install; place holds first)",
          options: { json: JSON_OPTION },
          async run(input) {
            const report = await recovery.arm();
            const connectivity = recoveryEntries(report, null);
            return output(
              input.options.json,
              report,
              `Connectivity recovery armed.\n${connectivity.map(textRecoveryEntry).join("\n")}${connectivity.length > 0 ? "\n" : ""}`,
            );
          },
        }),
        watchdog: cliCommand({
          summary: "Run the stalled-turn check now",
          options: { json: JSON_OPTION },
          async run(input) {
            const report = await extras.watchdog.check();
            return output(input.options.json, report, `${watchdogLines(report, null).join("\n")}\n`);
          },
        }),
        scan: cliCommand({
          summary: "Run the connectivity recovery scan now",
          options: { json: JSON_OPTION },
          async run(input) {
            const report = await recovery.scan();
            const connectivity = recoveryEntries(report, null);
            return output(
              input.options.json,
              report,
              report.enabled
                ? connectivity.length === 0
                  ? "Nothing is waiting for connectivity.\n"
                  : `${connectivity.map(textRecoveryEntry).join("\n")}\n`
                : "Connectivity recovery is off (setting transportRecovery).\n",
            );
          },
        }),
      },
    }),
  );
}
