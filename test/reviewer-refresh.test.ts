// Rev 4 closure-check blocker, from the independent review (verbatim).
import { expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createTransportRecovery } from "../src/recovery.js";
import { CODEX_HIGH, FAILURES, FakeCore } from "./fake-core.js";

it("a newer failure invalidates an older chain refresh already in flight", async () => {
  const core = new FakeCore();
  core.addThread({ id: "review-refresh", providerId: "codex" });
  core.startTurn("review-refresh", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-refresh", FAILURES.codexPooler);
  await core.retry({ threadId: "review-refresh", reason: "Connectivity restored", sendAt: core.now + 1000 });
  const row = core.queue[0]!;
  const sdk = core.sdk();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void;
  const capturedRequest = new Promise<void>((resolve) => { captured = resolve; });
  let intercept = true;
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: {
    ...sdk,
    threads: {
      ...sdk.threads,
      events: { list: async (args: Parameters<typeof sdk.threads.events.list>[0]) => {
        const result = await sdk.threads.events.list(args);
        if (intercept && args.types?.includes("client/turn/requested")) {
          intercept = false;
          captured();
          await blocked;
        }
        return result;
      } },
    },
  } as never });
  await host.bb.storage.kv.set("armed", { at: 0 });
  const recovery = createTransportRecovery(host.bb, {
    now: () => core.now, enabled: () => true, probe: async () => ({ reachable: true, detail: "HTTP 405" }),
  });
  await recovery.init();
  core.hook = (context) => recovery.decideDispatch(context as never);
  expect((await core.runHook("review-refresh", [row])).action).toBe("wait");
  await capturedRequest;
  // A later manual turn is legal while an older retry is waiting. It fails
  // before the old refresh response is delivered to the plugin.
  core.startTurn("review-refresh", { input: [], execution: CODEX_HIGH });
  core.failTurn("review-refresh", FAILURES.unauthorized);
  recovery.noteFailure("review-refresh"); // exactly server.ts's event wiring
  release();
  await Bun.sleep(5);
  core.now += 1001;
  await core.drain();
  expect(core.thread("review-refresh").status).toBe("error");
});
