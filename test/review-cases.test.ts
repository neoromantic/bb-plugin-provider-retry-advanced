// The six failing cases from the independent review of rev 2 (thr review, 2026-10-24), kept as acceptance tests.
// Adaptations, all to match real core/CLI behavior: the fake core now runs the plugin's message.dispatch hook on
// drains (core does, see dispatch-hooks.ts), setHostOnline/retry are awaited, a hold is placed through the CLI
// (the only way a hold is made), case 6 arms first so it tests the availability-lookup window, not the arm gate,
// and plugin and fake core share one clock. The last three cases are the rev 3 review's boundary tests, unchanged.
import { expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import { CODEX_HIGH, FAILURES, FakeCore } from "./fake-core.js";

function wire(core: FakeCore, host: ReturnType<typeof createFakePluginHost>) {
  core.hook = (context) => host.harness.registrations.hooks["message.dispatch"]!(context as never);
  core.onRowCancelled = (row) => host.harness.behavior.emitThreadEvent("message.cancelled", { entry: row } as never);
}

async function queuedFailure() {
  const core = new FakeCore();
  core.addThread({ id: "review-thread", providerId: "codex", environmentHostId: "review-host" });
  core.startTurn("review-thread", { input: [], execution: CODEX_HIGH });
  await core.setHostOnline("review-host", false);
  core.interruptTurn("review-thread", "host-daemon-restarted", "host-connection-lost");
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  await createPlugin({ now: () => core.now, probe: async () => ({ reachable: true, detail: "HTTP 405" }) })(host.bb);
  wire(core, host);
  await host.harness.runCli(["arm"]);
  expect(core.queue).toHaveLength(1);
  return { core, host };
}

it("hold removes an already queued connectivity retry before host reconnect", async () => {
  const { core, host } = await queuedFailure();
  await host.harness.runCli(["hold", "review-thread"]);
  expect(core.queue).toHaveLength(0); // withdrawn by hold itself, not only at the next scan
  await host.harness.runCli(["scan"]);
  expect(core.queue).toHaveLength(0);
});

it("removes an old retry when a different turn has already failed", async () => {
  const { core, host } = await queuedFailure();
  core.startTurn("review-thread", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-thread", FAILURES.unauthorized);
  await host.harness.behavior.emitThreadEvent("turn.failed", {
    threadId: "review-thread", requestId: core.lastRequest("review-thread")!.data.requestId as string, turnId: null,
    errorInfo: FAILURES.unauthorized.errorInfo, inputAccepted: true, rateLimits: null, attemptNumber: 1,
  });
  // Even before any scan, a drain must not run the superseded retry.
  core.now += 1;
  await core.setHostOnline("review-host", true);
  expect(core.thread("review-thread").status).toBe("error");
  await Bun.sleep(5);
  await host.harness.runCli(["scan"]);
  expect(core.queue).toHaveLength(0);
});

it("classifies the final error even after 500 earlier provider errors", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-thread", providerId: "codex" });
  core.startTurn("review-thread", { input: [], execution: CODEX_HIGH });
  for (let i = 0; i < 500; i++) core.append("review-thread", "provider/error", FAILURES.codexPooler);
  core.failTurn("review-thread", FAILURES.unauthorized);
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  await createPlugin({ now: () => core.now, probe: async () => ({ reachable: true, detail: "HTTP 405" }) })(host.bb);
  wire(core, host);
  await host.harness.runCli(["arm"]);
  expect(host.harness.inspection.sdk.callsTo("threads.retry")).toHaveLength(0);
});

it("does not wake a stopped thread when host reconnects before the next scan", async () => {
  const { core } = await queuedFailure();
  core.setThread("review-thread", { status: "idle" });
  await core.setHostOnline("review-host", true);
  expect(core.thread("review-thread").status).toBe("idle");
  await Bun.sleep(5);
  expect(core.queue).toHaveLength(0); // and the withdrawn row is taken off the queue
});

it("fresh install observes overload failures until arm as promised", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-thread", providerId: "codex" });
  const requestId = core.startTurn("review-thread", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-thread", FAILURES.overloaded);
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  await createPlugin({ now: () => core.now })(host.bb);
  await host.harness.behavior.emitThreadEvent("turn.failed", {
    threadId: "review-thread", requestId, turnId: null, errorInfo: FAILURES.overloaded.errorInfo,
    inputAccepted: true, rateLimits: null, attemptNumber: 1,
  });
  expect(host.harness.inspection.sdk.callsTo("threads.retry")).toHaveLength(0);
});

it("honours a hold placed while a stock availability RPC is pending", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-thread", providerId: "codex" });
  const requestId = core.startTurn("review-thread", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-thread", FAILURES.rateLimit);
  let host: ReturnType<typeof createFakePluginHost>;
  const sdk = core.sdk();
  host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: {
    ...sdk,
    plugins: {
      experimental_discoverRpc: async () => [{ pluginId: "review-pool" }],
      callRpc: async () => {
        await host.harness.runCli(["hold", "review-thread"]);
        return { kind: "ready" };
      },
    },
  } as never });
  await createPlugin({ now: () => core.now })(host.bb);
  await host.harness.runCli(["arm"]);
  await host.harness.behavior.emitThreadEvent("turn.failed", {
    threadId: "review-thread", requestId, turnId: null, errorInfo: FAILURES.rateLimit.errorInfo,
    inputAccepted: true, rateLimits: null, attemptNumber: 1,
  });
  expect(host.harness.inspection.sdk.callsTo("threads.retry")).toHaveLength(0);
});

// --- rev 3 review boundary cases (verbatim) ---

it("does not dispatch a superseded row claimed during the first scan after reload", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-reload", providerId: "codex", environmentHostId: "review-host" });
  core.startTurn("review-reload", { input: [], execution: CODEX_HIGH });
  await core.setHostOnline("review-host", false);
  core.interruptTurn("review-reload", "host-daemon-restarted", "host-connection-lost");
  const factory = createPlugin({ probe: async () => ({ reachable: true, detail: "HTTP 405" }) });
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  await factory(host.bb);
  core.hook = (c) => host.harness.registrations.hooks["message.dispatch"]!(c as never);
  await host.harness.runCli(["arm"]);
  const row = core.queue[0]!;
  core.startTurn("review-reload", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-reload", FAILURES.unauthorized);
  // Reload loses lastFailureAt. A drain claims the old row while the new
  // plugin is loading; its hook waits for the first scan to read the state.
  const reloaded = await host.harness.lifecycle.reload(factory);
  core.hook = (c) => reloaded.harness.registrations.hooks["message.dispatch"]!(c as never);
  core.hostsOnline.set("review-host", true); // reconnect made the row drainable
  row.state = "claimed";
  const deferred = await core.runHook("review-reload", [row]);
  expect(deferred.action).toBe("wait");
  // Core may still be finishing/requeueing the claim while that scan runs.
  await reloaded.harness.runCli(["scan"]);
  expect(core.queue).toHaveLength(1);
  row.state = "queued";
  row.waitingOn = { kind: "plugin" };
  row.sendAt = deferred.sendAt!;
  core.now = row.sendAt + 1;
  await core.setHostOnline("review-host", true);
  expect(core.thread("review-reload").status).toBe("error");
});

it("does not require a later millisecond to identify a superseding failed request", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-clock", providerId: "codex", environmentHostId: "review-host" });
  core.startTurn("review-clock", { input: [], execution: CODEX_HIGH });
  await core.setHostOnline("review-host", false);
  core.interruptTurn("review-clock", "host-daemon-restarted", "host-connection-lost");
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  // The API row and the event handler can have the same Date.now() value;
  // request sequence/identity still distinguishes the new failed request.
  await createPlugin({ now: () => core.now, probe: async () => ({ reachable: true, detail: "HTTP 405" }) })(host.bb);
  core.hook = (c) => host.harness.registrations.hooks["message.dispatch"]!(c as never);
  await host.harness.runCli(["arm"]);
  core.startTurn("review-clock", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-clock", FAILURES.unauthorized);
  await host.harness.behavior.emitThreadEvent("turn.failed", {
    threadId: "review-clock", requestId: core.lastRequest("review-clock")!.data.requestId as string,
    turnId: null, errorInfo: FAILURES.unauthorized.errorInfo, inputAccepted: true, rateLimits: null, attemptNumber: 1,
  });
  await core.setHostOnline("review-host", true);
  expect(core.thread("review-clock").status).toBe("error");
});

it("unarmed installation does not dispatch an existing automatic retry after the observing scan", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-unarmed", providerId: "codex" });
  const requestId = core.startTurn("review-unarmed", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-unarmed", FAILURES.overloaded);
  // An ordinary durable row can survive disabling/removing the old recovery
  // owner, and uses exactly the stock reason that this plugin adopts as own.
  await core.retry({ threadId: "review-unarmed", turnRequestId: requestId,
    sendAt: core.now + 1000, reason: "Provider overloaded" });
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  await createPlugin({ now: () => core.now })(host.bb);
  core.hook = (c) => host.harness.registrations.hooks["message.dispatch"]!(c as never);
  const scan = await host.harness.runCli(["scan", "--json"]);
  expect(JSON.parse(scan.stdout).armed).toBe(false);
  core.now += 1001;
  await core.drain();
  expect(core.thread("review-unarmed").status).toBe("error");
});
