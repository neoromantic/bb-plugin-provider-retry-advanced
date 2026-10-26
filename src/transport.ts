/**
 * Where a transport failure needs connectivity back before a retry can work.
 *
 * - `provider`: the provider's API was unreachable from this server (directly
 *   or through Account Pooler); recovery waits for that API host to answer.
 * - `host`: the server lost the thread's machine; core queues the retry with a
 *   native `host-offline` wait until that machine is connected again.
 */
export type TransportRoute =
  | { kind: "provider"; target: ProbeTargetId }
  | { kind: "host" };

export type ProbeTargetId = "anthropic" | "chatgpt";

export type FailureClass =
  | { kind: "transport"; route: TransportRoute; signal: string }
  | { kind: "other"; reason: string };

/** The few fields of a stored thread event the classifier reads. */
export interface EventLike {
  seq: number;
  type: string;
  data: unknown;
}

/** Provider ids this plugin knows a reachability probe for. */
const PROVIDER_TARGETS: Record<string, ProbeTargetId> = {
  "claude-code": "anthropic",
  codex: "chatgpt",
};

export function probeTargetForProvider(providerId: string): ProbeTargetId | null {
  return PROVIDER_TARGETS[providerId] ?? null;
}

/** Categories a provider reports for a lost or refused connection. */
const TRANSPORT_CATEGORIES = new Set<string>([
  "connection-failed",
  "stream-disconnected",
]);

/**
 * Categories whose structured class is not about reachability, whatever the
 * message says. A plain 5xx stays here unless its text names a network or
 * gateway reachability failure (see NETWORK_SIGNATURE).
 */
const AMBIGUOUS_CATEGORIES = new Set<string>([
  "internal",
  "unknown",
  "none",
]);

/**
 * Text that only a reachability failure produces: Account Pooler's own 502
 * for an upstream it could not reach, Node/undici socket errors, and the
 * provider CLIs' connection errors. A provider's own "Internal server error"
 * or "Overloaded" never matches.
 */
const NETWORK_SIGNATURE =
  /Account Pooler could not reach|\bE(?:TIMEDOUT|CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|NETUNREACH|NETDOWN|HOSTUNREACH|PIPE)\b|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)|socket hang up|fetch failed|getaddrinfo|Connection error|Request timed out|error sending request|network is unreachable|stream disconnected/i;

interface ProviderErrorData {
  message?: unknown;
  detail?: unknown;
  errorInfo?: { category?: unknown; httpStatusCode?: unknown } | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isTransportError(data: ProviderErrorData): string | null {
  const category = categoryOf(data);
  if (TRANSPORT_CATEGORIES.has(category)) return category;
  if (!AMBIGUOUS_CATEGORIES.has(category)) return null;
  const match = NETWORK_SIGNATURE.exec(`${text(data.message)} ${text(data.detail)}`);
  return match === null ? null : match[0];
}

function categoryOf(data: ProviderErrorData): string {
  return typeof data.errorInfo?.category === "string" ? data.errorInfo.category : "none";
}

/**
 * Classifies the failed turn from the events that followed its request.
 *
 * The decisive error is the last `provider/error` before the turn completed
 * as failed: provider CLIs keep their own in-turn retries (`willRetry: true`)
 * and can emit more errors after the turn ended, from work the turn left
 * running, so the error that actually ended the turn is the one before the
 * completion. A lost machine has no provider error; core records it as an
 * interruption: `host-connection-lost` when the connection dropped, or a bare
 * `host-daemon-restarted` when the machine came back with a new daemon.
 */
export function classifyFailedTurn(args: {
  providerId: string;
  events: readonly EventLike[];
}): FailureClass {
  const interrupted = args.events.find((event) => event.type === "system/thread/interrupted");
  if (interrupted !== undefined) {
    const data = (interrupted.data ?? {}) as { reason?: unknown; cause?: unknown };
    if (data.cause === "host-connection-lost") {
      return { kind: "transport", route: { kind: "host" }, signal: "host-connection-lost" };
    }
    if (data.reason === "host-daemon-restarted") {
      return { kind: "transport", route: { kind: "host" }, signal: "host-daemon-restarted" };
    }
    return { kind: "other", reason: `interrupted:${text(data.reason) || "unknown"}` };
  }
  const completion = args.events.find(
    (event) =>
      event.type === "turn/completed" &&
      (event.data as { status?: unknown } | null)?.status === "failed",
  );
  const errors = args.events.filter(
    (event) =>
      event.type === "provider/error" &&
      (completion === undefined || event.seq < completion.seq),
  );
  const decisive = errors.at(-1);
  if (decisive === undefined) return { kind: "other", reason: "no-provider-error" };
  const data = (decisive.data ?? {}) as ProviderErrorData;
  const signal = isTransportError(data);
  if (signal === null) return { kind: "other", reason: `not-transport:${categoryOf(data)}` };
  const target = probeTargetForProvider(args.providerId);
  if (target === null) return { kind: "other", reason: `unsupported-provider:${args.providerId}` };
  return { kind: "transport", route: { kind: "provider", target }, signal };
}
