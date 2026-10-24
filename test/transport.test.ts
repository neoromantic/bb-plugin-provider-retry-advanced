import { describe, expect, it } from "bun:test";
import { PROBE_URLS, createProbe } from "../src/probe.js";
import { classifyFailedTurn, type EventLike } from "../src/transport.js";

const claudeRetry = (n: number): EventLike => ({
  seq: n,
  type: "provider/error",
  data: {
    message: "Provider error",
    detail: `Claude Code API retry ${n}/10 after 30000ms: HTTP 502 server_error`,
    willRetry: true,
    errorInfo: { category: "internal", providerCode: "server_error", httpStatusCode: 502 },
  },
});

describe("classifyFailedTurn", () => {
  it("uses the error that ended the turn, not later errors from work the turn left running", () => {
    // Shape of an incident thread: in-turn CLI retries, the pooler's final
    // 502, the failed completion, then a provider-side call after a
    // background task ended (no new client request) that also errored.
    const events: EventLike[] = [
      claudeRetry(1),
      claudeRetry(2),
      {
        seq: 3,
        type: "provider/error",
        data: {
          message: "Provider error",
          detail: "API Error: 502 Account Pooler could not reach Anthropic. This is a server-side issue, usually temporary.",
          errorInfo: { category: "internal", providerCode: null, httpStatusCode: 502 },
        },
      },
      { seq: 4, type: "turn/completed", data: { status: "failed" } },
      {
        seq: 5,
        type: "provider/error",
        data: { message: "Provider error", detail: "API Error: 401 authentication_error", errorInfo: { category: "unauthorized", providerCode: null, httpStatusCode: 401 } },
      },
    ];
    expect(classifyFailedTurn({ providerId: "claude-code", events })).toEqual({
      kind: "transport",
      route: { kind: "provider", target: "anthropic" },
      signal: "Account Pooler could not reach",
    });
  });

  it("does not treat a bare provider 502 retry notice as connectivity", () => {
    const events: EventLike[] = [claudeRetry(1), { seq: 2, type: "turn/completed", data: { status: "failed" } }];
    expect(classifyFailedTurn({ providerId: "claude-code", events })).toEqual({
      kind: "other",
      reason: "not-transport:internal",
    });
  });

  it("routes a lost machine to the native host wait and ignores providers it cannot probe", () => {
    expect(
      classifyFailedTurn({
        providerId: "pi",
        events: [{ seq: 1, type: "system/thread/interrupted", data: { reason: "host-daemon-restarted", cause: "host-connection-lost" } }],
      }),
    ).toEqual({ kind: "transport", route: { kind: "host" }, signal: "host-connection-lost" });
    expect(
      classifyFailedTurn({
        providerId: "pi",
        events: [
          { seq: 1, type: "provider/error", data: { detail: "fetch failed", errorInfo: { category: "connection-failed", providerCode: null, httpStatusCode: null } } },
        ],
      }),
    ).toEqual({ kind: "other", reason: "unsupported-provider:pi" });
  });
});

describe("createProbe", () => {
  function fakeFetch(respond: () => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("sends one unauthenticated HEAD to the provider API and treats any answer below 500 as reachable", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 405 }));
    expect(await createProbe(impl)("anthropic")).toEqual({ reachable: true, detail: "HTTP 405" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(PROBE_URLS.anthropic);
    expect(calls[0]!.init.method).toBe("HEAD");
    expect(calls[0]!.init.headers).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("treats a 5xx edge answer, a timeout or a socket error as unreachable", async () => {
    expect(await createProbe(fakeFetch(() => new Response(null, { status: 503 })).impl)("chatgpt")).toEqual({
      reachable: false,
      detail: "HTTP 503",
    });
    const socket = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    expect(await createProbe(fakeFetch(() => Promise.reject(socket)).impl)("chatgpt")).toEqual({
      reachable: false,
      detail: "ETIMEDOUT",
    });
  });
});
