import type { ProbeTargetId } from "./transport.js";

/**
 * The provider API endpoints a failed turn was trying to reach (the same
 * upstreams Account Pooler forwards to). A probe is one unauthenticated HEAD:
 * no token, no model call, no usage query. Any HTTP answer below 500 (the
 * APIs answer 401/404/405 to it) shows only that this server reaches the
 * provider's API edge again — not account, quota or Account Pooler health;
 * a timeout, socket error or 5xx edge answer means not reachable.
 */
export const PROBE_URLS: Record<ProbeTargetId, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  chatgpt: "https://chatgpt.com/backend-api/codex/responses",
};

export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeResult {
  reachable: boolean;
  detail: string;
}

export type ProbeFn = (target: ProbeTargetId) => Promise<ProbeResult>;

function errorDetail(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (error instanceof Error) return error.name === "TimeoutError" ? "timeout" : error.message;
  return String(error);
}

export function createProbe(fetchImpl: typeof fetch = fetch): ProbeFn {
  return async (target) => {
    try {
      const response = await fetchImpl(PROBE_URLS[target], {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return {
        reachable: response.status < 500,
        detail: `HTTP ${response.status}`,
      };
    } catch (error) {
      return { reachable: false, detail: errorDetail(error) };
    }
  };
}
