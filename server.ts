// Derived from get-bb/bb plugins/provider-retry/server.ts (MIT, desktop-v0.46.1).
// Changes: the stock overload/subscription-limit policy runs only for those
// failures; connectivity (transport) failures are recovered by a fixed 60s
// scan that probes the provider path and asks core to retry natively.
import {
  readRetryDiagnostic,
  retryDiagnosticContract,
} from "./src/diagnostics.js";
import {
  retryAvailabilityMethod,
  retryAvailabilitySchema,
  type RetryAvailability,
} from "./src/retry-contract.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerProviderRetryCli } from "./src/cli.js";
import { createProbe, type ProbeFn } from "./src/probe.js";
import { createTransportRecovery, runRecoveryLoop } from "./src/recovery.js";
import {
  DEFAULT_MAXIMUM_WAIT_MS,
  decideRetry,
  isRateLimitFailure,
} from "./src/retry-policy.js";

const MAXIMUM_WAIT_OPTIONS = ["6 hours", "24 hours", "No limit"] as const;

function maximumWaitMs(value: string): number | null {
  switch (value) {
    case "6 hours":
      return DEFAULT_MAXIMUM_WAIT_MS;
    case "24 hours":
      return 24 * 60 * 60 * 1_000;
    case "No limit":
      return null;
    default:
      throw new Error(
        `Unsupported maximum provider retry wait: ${String(value)}`,
      );
  }
}

export interface PluginOptions {
  probe?: ProbeFn;
  now?: () => number;
}

export function createPlugin(options: PluginOptions = {}) {
  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({
      maximumWait: {
        type: "select",
        label: "Maximum automatic wait",
        description:
          "Do not schedule a subscription-limit retry when its reset is farther away than this.",
        options: [...MAXIMUM_WAIT_OPTIONS],
        default: "6 hours",
      },
      transportRecovery: {
        type: "boolean",
        label: "Resume after connectivity returns",
        description:
          "Every 60 seconds, resume turns that failed because the provider or machine was unreachable, once it answers again. No attempt limit.",
        default: true,
      },
    });
    const initialSettings = await settings.get();
    let maximumWait = maximumWaitMs(initialSettings.maximumWait);
    let transportRecovery = initialSettings.transportRecovery;
    settings.onChange((next) => {
      maximumWait = maximumWaitMs(next.maximumWait);
      transportRecovery = next.transportRecovery;
    });

    const recovery = createTransportRecovery(bb, {
      probe: options.probe ?? createProbe(),
      enabled: () => transportRecovery,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    bb.rpc.register(retryDiagnosticContract, {
      "decision.get": ({ threadId }) => readRetryDiagnostic(bb, threadId),
    });

    // Stock policy, unchanged, for the two failure kinds it owns. Every other
    // failure is classified by the connectivity scan from the turn's events.
    await recovery.init();
    bb.events.on("turn.failed", async (event) => {
      recovery.noteFailure(event.threadId);
      if (event.errorInfo?.category !== "overloaded" && !isRateLimitFailure(event)) {
        return;
      }
      // Fork: nothing is retried automatically before `arm`, or on a held thread.
      const gate = () =>
        !recovery.isArmed() ? "not-armed" : recovery.isHeld(event.threadId) ? "held" : null;
      const declineFor = async (reason: string) => {
        await bb.storage.kv.set(`decision:${event.threadId}`, {
          requestId: event.requestId,
          observedAt: Date.now(),
          availability: { kind: "not-routed" },
          decision: { kind: "decline", reason },
        });
        bb.log.info(`Automatic retry skipped for ${event.threadId}: ${reason}.`);
      };
      const before = gate();
      if (before !== null) return declineFor(before);
      let availability: RetryAvailability = { kind: "not-routed" };
      if (isRateLimitFailure(event)) {
        const sources = await bb.sdk.plugins.experimental_discoverRpc({
          method: retryAvailabilityMethod,
        });
        for (const source of sources) {
          try {
            // Fork: inferring callRpc's output from the zod schema exceeds
            // TypeScript's instantiation depth outside the BB monorepo, so the
            // answer is parsed with the same schema the host validates with.
            const result = retryAvailabilitySchema.parse(
              await bb.sdk.plugins.callRpc({
                pluginId: source.pluginId,
                method: retryAvailabilityMethod,
                input: { threadId: event.threadId, requestId: event.requestId },
                outputSchema: retryAvailabilitySchema as never,
                signal: AbortSignal.timeout(5_000),
              }),
            );
            if (result.kind !== "not-routed") {
              availability = result;
              break;
            }
          } catch (error) {
            bb.log.warn(
              `Retry availability failed for ${event.threadId}: ${String(error)}`,
            );
            availability = { kind: "unavailable", reason: "source-unavailable" };
          }
        }
      }
      const decision = decideRetry({
        availability,
        failure: event,
        maximumWaitMs: maximumWait,
        now: Date.now(),
        random: Math.random(),
      });
      const recordDecision = () =>
        bb.storage.kv.set(`decision:${event.threadId}`, {
          requestId: event.requestId,
          observedAt: Date.now(),
          availability,
          decision,
        });
      // Fork: the availability lookup can take seconds; re-check the gate after it.
      const after = gate();
      if (after !== null) return declineFor(after);
      if (decision.kind === "decline") {
        await recordDecision();
        bb.log.info(
          `Automatic retry skipped for ${event.threadId}: ${decision.reason}${availability.kind === "unavailable" ? ` (${availability.reason})` : ""}.`,
        );
        return;
      }
      await bb.sdk.threads.retry({
        threadId: event.threadId,
        turnRequestId: event.requestId,
        sendAt: decision.sendAt,
        reason: decision.reason,
      });
      await recordDecision();
    });

    // Core asks before every attempt and every queued drain; this is where a
    // hold, cancel, stop or newer failure stops an already queued retry.
    bb.experimental_hooks.on("message.dispatch", (context) =>
      recovery.decideDispatch(context),
    );

    // A retry row the user deleted is a decision about that failure.
    bb.events.on("message.cancelled", ({ entry }) =>
      recovery.onRetryRowCancelled(entry),
    );

    bb.background.service("connectivity-recovery", {
      start: (signal) => runRecoveryLoop({ recovery, signal, log: bb.log }),
    });

    registerProviderRetryCli(bb, recovery);
  };
}

export default createPlugin();
