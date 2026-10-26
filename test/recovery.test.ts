import { describe, expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import type { ProbeResult } from "../src/probe.js";
import { SCAN_INTERVAL_MS, runRecoveryLoop, type ScanReport } from "../src/recovery.js";
import {
  CODEX_HIGH,
  CONTINUE_ACCEPTED_TURN_TEXT,
  FAILURES,
  FakeCore,
  OPUS_ULTRACODE,
  type Execution,
} from "./fake-core.js";

const PLUGIN_ID = "provider-retry-advanced";
const ORIGINAL_TASK = "Original task text";

async function setup(options: { reachable?: boolean; onProbe?: () => void; armed?: boolean } = {}) {
  const core = new FakeCore();
  const probes: string[] = [];
  let reachable = options.reachable ?? true;
  const probe = async (target: string): Promise<ProbeResult> => {
    probes.push(target);
    options.onProbe?.();
    return reachable ? { reachable: true, detail: "HTTP 405" } : { reachable: false, detail: "ETIMEDOUT" };
  };
  const host = createFakePluginHost({ pluginId: PLUGIN_ID, sdk: core.sdk() as never });
  await createPlugin({ probe, now: () => core.now })(host.bb);
  core.hook = (context) => host.harness.registrations.hooks["message.dispatch"]!(context as never);
  core.onRowCancelled = (row) => host.harness.behavior.emitThreadEvent("message.cancelled", { entry: row } as never);
  if (options.armed !== false) expect((await host.harness.runCli(["arm"])).exitCode).toBe(0);
  const scan = async (): Promise<ScanReport> => {
    const result = await host.harness.runCli(["scan", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ScanReport;
  };
  return {
    core,
    host,
    probes,
    scan,
    setReachable: (value: boolean) => {
      reachable = value;
    },
    retries: () => host.harness.inspection.sdk.callsTo("threads.retry"),
  };
}

function failedThread(
  core: FakeCore,
  id: string,
  args: {
    providerId?: string;
    failure?: { detail?: string; errorInfo: Record<string, unknown> | null };
    execution?: Execution;
    accepted?: boolean;
    before?: (core: FakeCore) => void;
  } = {},
) {
  core.addThread({ id, providerId: args.providerId ?? "claude-code" });
  core.startTurn(id, {
    input: [{ type: "text", text: ORIGINAL_TASK, mentions: [] }],
    execution: args.execution ?? OPUS_ULTRACODE,
    accepted: args.accepted ?? true,
  });
  args.before?.(core);
  core.failTurn(id, args.failure ?? FAILURES.claudePooler);
}

function entry(report: ScanReport, threadId: string) {
  return report.entries.find((e) => e.threadId === threadId);
}

describe("connectivity recovery", () => {
  it("waits while the provider is unreachable and resumes once when it answers", async () => {
    const t = await setup({ reachable: false });
    failedThread(t.core, "thr_a");
    for (let i = 0; i < 3; i++) {
      const report = await t.scan();
      expect(entry(report, "thr_a")?.state).toBe("waiting");
      expect(entry(report, "thr_a")?.reason).toBe("waiting-for-connectivity (anthropic: ETIMEDOUT)");
    }
    expect(t.retries()).toHaveLength(0);
    expect(t.probes).toEqual(["anthropic", "anthropic", "anthropic"]);

    t.setReachable(true);
    expect(entry(await t.scan(), "thr_a")?.state).toBe("resumed");
    expect(t.retries()).toEqual([[{ threadId: "thr_a", turnRequestId: expect.any(String), reason: "Connectivity restored" }]]);
    expect(t.core.thread("thr_a").status).toBe("active");

    // Next tick reads current native state: nothing failed, nothing probed.
    const after = await t.scan();
    expect(after.entries).toEqual([]);
    expect(t.retries()).toHaveLength(1);
    expect(t.probes).toHaveLength(4);
  });

  it("has no exhausted state: eight consecutive connectivity failures are each resumed", async () => {
    const t = await setup();
    failedThread(t.core, "thr_b");
    const original = t.core.lastRequest("thr_b")!.data.requestId;
    for (let attempt = 2; attempt <= 9; attempt++) {
      expect(entry(await t.scan(), "thr_b")?.state).toBe("resumed");
      const request = t.core.lastRequest("thr_b")!.data;
      expect(request.retryAttempt).toBe(attempt);
      expect(request.retryOfRequestId).toBe(original);
      t.core.failTurn("thr_b", FAILURES.claudePooler);
    }
    expect(t.retries()).toHaveLength(8);
  });

  it("keeps a fixed 60 second cadence whatever the scans find", async () => {
    const waits: number[] = [];
    const controller = new AbortController();
    let scans = 0;
    await runRecoveryLoop({
      recovery: {
        scan: async () => {
          scans += 1;
          if (scans % 2 === 0) throw new Error("scan failed");
          return {} as ScanReport;
        },
      } as never,
      signal: controller.signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 7) controller.abort();
      },
    });
    expect(scans).toBe(7);
    expect(waits).toEqual(Array(7).fill(SCAN_INTERVAL_MS));
  });

  it("recovers failures from before the plugin loaded on service start", async () => {
    const core = new FakeCore();
    failedThread(core, "thr_old", { providerId: "codex", failure: FAILURES.codexPooler, execution: CODEX_HIGH });
    const host = createFakePluginHost({ pluginId: PLUGIN_ID, sdk: core.sdk() as never });
    await host.bb.storage.kv.set("armed", { at: 0 }); // armed on an earlier load
    await createPlugin({ probe: async () => ({ reachable: true, detail: "HTTP 405" }) })(host.bb);
    const { controller, done } = host.harness.behavior.runService("connectivity-recovery");
    for (let i = 0; i < 50 && core.thread("thr_old").status !== "active"; i++) await Bun.sleep(5);
    controller.abort();
    await done;
    expect(core.thread("thr_old").status).toBe("active");
    expect(core.lastRequest("thr_old")!.data.input).toEqual([
      { type: "text", text: CONTINUE_ACCEPTED_TURN_TEXT, mentions: [], visibility: "agent-only" },
    ]);
  });

  it("does not probe the network when nothing waits for it", async () => {
    const t = await setup();
    await t.scan();
    failedThread(t.core, "thr_auth", { failure: FAILURES.unauthorized });
    await t.scan();
    expect(t.probes).toEqual([]);
    expect(t.retries()).toEqual([]);
  });

  it.each([
    ["Account Pooler 502 for Claude", "claude-code", FAILURES.claudePooler, "anthropic"],
    ["Account Pooler 502 for Codex", "codex", FAILURES.codexPooler, "chatgpt"],
    ["Claude connection error while offline", "claude-code", FAILURES.claudeOffline, "anthropic"],
    ["Codex stream disconnected", "codex", FAILURES.codexStream, "chatgpt"],
  ] as const)("resumes a connectivity failure: %s", async (_name, providerId, failure, target) => {
    const t = await setup();
    failedThread(t.core, "thr_c", { providerId, failure });
    expect(entry(await t.scan(), "thr_c")?.state).toBe("resumed");
    expect(t.probes).toEqual([target]);
  });

  it.each([
    ["a provider's own 500", FAILURES.providerInternal500, "not-transport:internal"],
    ["authentication", FAILURES.unauthorized, "not-transport:unauthorized"],
    ["billing", FAILURES.billing, "not-transport:billing"],
    ["a subscription limit", FAILURES.rateLimit, "not-transport:rate-limit"],
    ["an overload", FAILURES.overloaded, "not-transport:overloaded"],
  ] as const)("leaves %s to other policies", async (_name, failure, reason) => {
    const t = await setup();
    failedThread(t.core, "thr_d", { failure });
    expect(entry(await t.scan(), "thr_d")).toMatchObject({ state: "skipped", reason });
    expect(t.retries()).toEqual([]);
    expect(t.probes).toEqual([]);
  });

  it("does not resume user stops, removed machines, idle provider turns, archived, deleted, held, cancelled, pending-approval or workflow-engine threads", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_stopped", providerId: "claude-code" });
    t.core.startTurn("thr_stopped", { input: [], execution: OPUS_ULTRACODE });
    t.core.interruptTurn("thr_stopped", "manual-stop");
    t.core.addThread({ id: "thr_removed", providerId: "claude-code" });
    t.core.startTurn("thr_removed", { input: [], execution: OPUS_ULTRACODE });
    t.core.interruptTurn("thr_removed", "host-removed");
    t.core.addThread({ id: "thr_idle", providerId: "claude-code" });
    t.core.startTurn("thr_idle", { input: [], execution: OPUS_ULTRACODE });
    t.core.interruptTurn("thr_idle", "provider-turn-idle");
    failedThread(t.core, "thr_archived");
    t.core.setThread("thr_archived", { archivedAt: t.core.now });
    failedThread(t.core, "thr_deleted");
    t.core.setThread("thr_deleted", { deletedAt: t.core.now });
    failedThread(t.core, "thr_held");
    failedThread(t.core, "thr_cancelled");
    failedThread(t.core, "thr_pending");
    t.core.setThread("thr_pending", { hasPendingInteraction: true });
    failedThread(t.core, "thr_worker");
    t.core.setThread("thr_worker", { originPluginId: "workflows", visibility: "hidden" });

    expect((await t.host.harness.runCli(["hold", "thr_held"])).exitCode).toBe(0);
    expect((await t.host.harness.runCli(["cancel", "thr_cancelled"])).exitCode).toBe(0);

    const report = await t.scan();
    expect(t.retries()).toEqual([]);
    expect(entry(report, "thr_stopped")).toBeUndefined();
    expect(entry(report, "thr_removed")).toBeUndefined();
    expect(entry(report, "thr_idle")?.reason).toBe("interrupted:provider-turn-idle");
    expect(entry(report, "thr_archived")).toBeUndefined();
    expect(entry(report, "thr_deleted")).toBeUndefined();
    expect(entry(report, "thr_held")?.reason).toBe("held");
    expect(entry(report, "thr_cancelled")?.reason).toBe("cancelled");
    expect(entry(report, "thr_pending")?.reason).toBe("pending-interaction");
    expect(entry(report, "thr_worker")?.reason).toBe("workflow-engine-owned");

    // Release makes the held thread eligible again.
    expect((await t.host.harness.runCli(["release", "thr_held"])).exitCode).toBe(0);
    expect(entry(await t.scan(), "thr_held")?.state).toBe("resumed");
  });

  it.each([
    ["archived", { archivedAt: 1 }, "state-changed:archived"],
    ["stopped by the user", { status: "idle" as const }, "state-changed:idle"],
    ["waiting for approval", { hasPendingInteraction: true }, "pending-interaction"],
  ])("re-checks native state right before sending: %s meanwhile", async (_name, patch, reason) => {
    let t: Awaited<ReturnType<typeof setup>>;
    t = await setup({ onProbe: () => t.core.setThread("thr_e", patch) });
    failedThread(t.core, "thr_e");
    const report = await t.scan();
    expect(t.retries()).toEqual([]);
    expect(entry(report, "thr_e")?.reason).toBe(reason);
  });

  it("never duplicates a queued or concurrent retry", async () => {
    const t = await setup();
    failedThread(t.core, "thr_q");
    // An existing (stock or manual) retry row on the thread wins.
    await t.core.retry({ threadId: "thr_q", sendAt: t.core.now + 3_600_000, reason: "Rate limited" });
    expect(entry(await t.scan(), "thr_q")?.reason).toBe("retry-queued");
    expect(t.retries()).toEqual([]);

    failedThread(t.core, "thr_r");
    await Promise.all([t.scan(), t.scan(), t.host.harness.runCli(["scan"])]);
    expect(t.retries()).toHaveLength(1);
  });

  it("waits natively for an offline machine, then lets core dispatch when it reconnects", async () => {
    const t = await setup({ reachable: false });
    t.core.addThread({ id: "thr_remote", providerId: "codex", environmentHostId: "host_remote" });
    t.core.startTurn("thr_remote", { input: [], execution: CODEX_HIGH });
    await t.core.setHostOnline("host_remote", false);
    t.core.interruptTurn("thr_remote", "host-daemon-restarted", "host-connection-lost");

    expect(entry(await t.scan(), "thr_remote")?.state).toBe("resumed");
    expect(t.probes).toEqual([]);
    expect(t.core.queue[0]?.waitingOn).toEqual({ kind: "host-offline", hostName: "host_remote" });
    expect(entry(await t.scan(), "thr_remote")?.reason).toBe("retry-queued");
    expect(t.retries()).toHaveLength(1);

    await t.core.setHostOnline("host_remote", true);
    expect(t.core.thread("thr_remote").status).toBe("active");
    expect(t.core.queue).toEqual([]);
  });

  it("continues a turn a daemon restart interrupted, in its session, unless held", async () => {
    const t = await setup({ reachable: false });
    const restart = (id: string) => {
      t.core.addThread({ id, providerId: "codex" });
      t.core.startTurn(id, { input: [{ type: "text", text: ORIGINAL_TASK, mentions: [] }], execution: CODEX_HIGH });
      // Core's events for a machine that came back with a new daemon (no `cause`).
      t.core.append(id, "turn/completed", { providerThreadId: `session-${id}`, status: "interrupted" });
      t.core.append(id, "system/error", {
        code: "thread_command_failed",
        message: "Thread interrupted because the host daemon disconnected",
        detail: "Please retry the thread to continue.",
      });
      t.core.interruptTurn(id, "host-daemon-restarted");
    };
    restart("thr_restarted");
    restart("thr_restart_held");
    expect((await t.host.harness.runCli(["hold", "thr_restart_held"])).exitCode).toBe(0);

    const report = await t.scan();
    expect(entry(report, "thr_restarted")?.state).toBe("resumed");
    expect(entry(report, "thr_restart_held")?.reason).toBe("held");
    expect(t.probes).toEqual([]);
    expect(t.retries()).toHaveLength(1);
    const continued = t.core.lastRequest("thr_restarted")!.data;
    expect(continued.execution).toEqual(CODEX_HIGH);
    expect(continued.input).toEqual([
      { type: "text", text: CONTINUE_ACCEPTED_TURN_TEXT, mentions: [], visibility: "agent-only" },
    ]);
  });

  it("removes only its own stale row when the thread moved on, and honours a user's cancelled row", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_s", providerId: "codex", environmentHostId: "host_remote" });
    t.core.startTurn("thr_s", { input: [], execution: CODEX_HIGH });
    await t.core.setHostOnline("host_remote", false);
    t.core.interruptTurn("thr_s", "host-daemon-restarted", "host-connection-lost");
    await t.scan();
    expect(t.core.queue).toHaveLength(1);
    // The user stops the thread instead: the waiting retry must not wake it later.
    t.core.setThread("thr_s", { status: "idle" });
    const report = await t.scan();
    expect(report.staleRowsRemoved).toBe(1);
    expect(t.core.queue).toEqual([]);

    // A row the user deleted from the queue card is a decision about that failure.
    failedThread(t.core, "thr_u");
    await t.core.setHostOnline("host_local", false);
    await t.scan();
    const row = t.core.queue.find((r) => r.threadId === "thr_u")!;
    t.core.queue = t.core.queue.filter((r) => r !== row);
    await t.host.harness.behavior.emitThreadEvent("message.cancelled", { entry: row } as never);
    await t.core.setHostOnline("host_local", true);
    expect(entry(await t.scan(), "thr_u")?.reason).toBe("cancelled");
    expect(t.retries()).toHaveLength(2);

    // A later, different failure on that thread is eligible again.
    t.core.startTurn("thr_u", { input: [{ type: "text", text: "new message", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.failTurn("thr_u", FAILURES.claudeOffline);
    expect(entry(await t.scan(), "thr_u")?.state).toBe("resumed");
  });

  it("continues accepted work natively with the failed turn's model, effort, tier and permissions", async () => {
    const t = await setup();
    failedThread(t.core, "thr_m", { execution: OPUS_ULTRACODE, accepted: true });
    failedThread(t.core, "thr_n", { providerId: "codex", failure: FAILURES.codexPooler, execution: CODEX_HIGH, accepted: false });
    await t.scan();

    const continued = t.core.lastRequest("thr_m")!.data;
    expect(continued.execution).toEqual(OPUS_ULTRACODE);
    expect(continued.input).toEqual([
      { type: "text", text: CONTINUE_ACCEPTED_TURN_TEXT, mentions: [], visibility: "agent-only" },
    ]);
    // Input the provider never accepted is re-sent, not replaced by a nudge.
    const resent = t.core.lastRequest("thr_n")!.data;
    expect(resent.execution).toEqual(CODEX_HIGH);
    expect(resent.input).toEqual([{ type: "text", text: ORIGINAL_TASK, mentions: [], visibility: "agent-only" }]);

    const paths = new Set(t.host.harness.inspection.sdk.calls.map((call) => call.path));
    for (const forbidden of ["threads.send", "threads.spawn", "threads.fork", "threads.stop"]) {
      expect(paths.has(forbidden)).toBe(false);
    }
  });

  it("continues an interrupted Claude ultracode workflow in its session without starting another", async () => {
    const t = await setup();
    let workflowItem = "";
    failedThread(t.core, "thr_wf", {
      execution: OPUS_ULTRACODE,
      before: (core) => {
        core.append("thr_wf", "item/completed", { item: { id: "step-1", type: "commandExecution", status: "completed" } });
        workflowItem = core.startBackgroundTask("thr_wf", "local_workflow");
      },
    });
    const eventsBefore = t.core.events.get("thr_wf")!.map((e) => e.id);

    const report = await t.scan();
    expect(entry(report, "thr_wf")).toMatchObject({ state: "resumed", openBackgroundTasks: 1 });

    const events = t.core.events.get("thr_wf")!;
    // History (completed steps, the running workflow) is untouched; the only
    // additions are core's own retry dispatch into the same provider session.
    expect(events.slice(0, eventsBefore.length).map((e) => e.id)).toEqual(eventsBefore);
    const added = events.slice(eventsBefore.length).map((e) => e.type);
    expect(added).toEqual(["client/turn/requested", "turn/started", "turn/input/accepted"]);
    expect(events.at(-1)!.data.providerThreadId).toBe("session-thr_wf");
    expect(events.filter((e) => e.type === "item/started" && (e.data.item as { type: string }).type === "backgroundTask")).toHaveLength(1);
    expect(events.some((e) => e.type === "item/backgroundTask/completed" && (e.data.item as { id: string }).id === workflowItem)).toBe(false);
    expect(t.core.lastRequest("thr_wf")!.data.input).toEqual([
      { type: "text", text: CONTINUE_ACCEPTED_TURN_TEXT, mentions: [], visibility: "agent-only" },
    ]);
    expect(t.core.thread("thr_wf").activity.activeWorkflowCount).toBe(1);
  });

  it("explains a waiting turn and lists it in status", async () => {
    const t = await setup({ reachable: false });
    failedThread(t.core, "thr_x", { providerId: "codex", failure: FAILURES.codexPooler, execution: CODEX_HIGH });
    await t.scan();
    const explained = await t.host.harness.runCli(["explain", "thr_x"]);
    expect(explained.stdout).toContain("Skipped: waiting-for-connectivity (chatgpt: ETIMEDOUT)");
    const status = await t.host.harness.runCli(["status"]);
    expect(status.stdout).toContain("thr_x\twaiting\twaiting-for-connectivity (chatgpt: ETIMEDOUT)");
    t.setReachable(true);
    await t.scan();
    expect((await t.host.harness.runCli(["explain", "thr_x"])).stdout).toContain("Connectivity restored");
  });

  it("does nothing while the transportRecovery setting is off", async () => {
    const t = await setup();
    await t.host.harness.setSettings({ transportRecovery: false });
    failedThread(t.core, "thr_off");
    const report = await t.scan();
    expect(report.enabled).toBe(false);
    expect(t.retries()).toEqual([]);
    expect(t.probes).toEqual([]);
  });

  it("leaves connectivity failures out of the stock turn.failed policy", async () => {
    const t = await setup();
    failedThread(t.core, "thr_tf");
    await t.host.harness.behavior.emitThreadEvent("turn.failed", {
      threadId: "thr_tf",
      requestId: t.core.lastRequest("thr_tf")!.data.requestId as string,
      turnId: null,
      errorInfo: { category: "internal", providerCode: null, httpStatusCode: 502 },
      inputAccepted: true,
      rateLimits: null,
      attemptNumber: 7,
    });
    expect(t.retries()).toEqual([]);
    expect((await t.host.harness.runCli(["explain", "thr_tf", "--json"])).stdout).toContain('"diagnostic": null');
  });
});

describe("first install", () => {
  it("only observes until armed, so holds placed first are respected", async () => {
    const t = await setup({ armed: false });
    failedThread(t.core, "thr_active");
    failedThread(t.core, "thr_paused");
    const observed = await t.scan();
    expect(observed.armed).toBe(false);
    expect(entry(observed, "thr_active")).toMatchObject({ state: "waiting", reason: "not-armed (run: bb provider-retry-advanced arm)" });
    expect(t.probes).toEqual([]);
    expect(t.retries()).toEqual([]);
    expect((await t.host.harness.runCli(["status"])).stdout).toContain("observing only");

    expect((await t.host.harness.runCli(["hold", "thr_paused"])).exitCode).toBe(0);
    const armed = JSON.parse((await t.host.harness.runCli(["arm", "--json"])).stdout) as ScanReport;
    expect(entry(armed, "thr_active")?.state).toBe("resumed");
    expect(entry(armed, "thr_paused")?.reason).toBe("held");
    expect(t.retries()).toHaveLength(1);
  });

  it("keeps arm and holds across a reload", async () => {
    const t = await setup();
    await t.host.harness.runCli(["hold", "thr_kept"]);
    const reloaded = await t.host.harness.lifecycle.reload(createPlugin({ probe: async () => ({ reachable: true, detail: "HTTP 405" }) }));
    failedThread(t.core, "thr_kept");
    failedThread(t.core, "thr_free");
    const report = JSON.parse((await reloaded.harness.runCli(["scan", "--json"])).stdout) as ScanReport;
    expect(report.armed).toBe(true);
    expect(entry(report, "thr_kept")?.reason).toBe("held");
    expect(entry(report, "thr_free")?.state).toBe("resumed");
  });

  it("does not let the stock overload policy retry a held thread", async () => {
    const t = await setup();
    failedThread(t.core, "thr_hold", { failure: FAILURES.overloaded });
    await t.host.harness.runCli(["hold", "thr_hold"]);
    await t.host.harness.behavior.emitThreadEvent("turn.failed", {
      threadId: "thr_hold",
      requestId: t.core.lastRequest("thr_hold")!.data.requestId as string,
      turnId: null,
      errorInfo: FAILURES.overloaded.errorInfo,
      inputAccepted: true,
      rateLimits: null,
      attemptNumber: 1,
    });
    expect(t.retries()).toEqual([]);
    expect((await t.host.harness.runCli(["explain", "thr_hold"])).stdout).toContain("Skipped: held");
  });
});

describe("dispatch-time enforcement", () => {
  it("finds the decisive error by the failed completion, whatever came before or after it", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_noise", providerId: "claude-code" });
    t.core.startTurn("thr_noise", { input: [], execution: OPUS_ULTRACODE });
    for (let i = 0; i < 600; i++) t.core.append("thr_noise", "provider/error", FAILURES.providerInternal500);
    t.core.failTurn("thr_noise", FAILURES.claudePooler);
    // A background task left running errors after the turn ended; it does not decide.
    t.core.append("thr_noise", "provider/error", FAILURES.unauthorized);
    expect(entry(await t.scan(), "thr_noise")?.state).toBe("resumed");
  });

  it("does not classify a turn that has not finished failing", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_open", providerId: "codex" });
    t.core.startTurn("thr_open", { input: [], execution: CODEX_HIGH });
    t.core.append("thr_open", "provider/error", FAILURES.codexPooler);
    t.core.setThread("thr_open", { status: "error" });
    expect(entry(await t.scan(), "thr_open")?.reason).toBe("incomplete");
    t.core.append("thr_open", "turn/completed", { status: "failed" });
    expect(entry(await t.scan(), "thr_open")?.state).toBe("resumed");
  });

  it("lets the dispatch hook refuse its own inline retry when a hold lands after the re-check", async () => {
    const t = await setup();
    failedThread(t.core, "thr_late");
    const pluginHook = t.core.hook!;
    t.core.hook = async (context) => {
      await t.host.harness.runCli(["hold", "thr_late"]); // lands between the plugin's re-read and core's dispatch
      return pluginHook(context);
    };
    const report = await t.scan();
    expect(entry(report, "thr_late")?.reason).toBe("core:dispatch_rejected");
    expect(t.core.thread("thr_late").status).toBe("error");
  });

  it("blocks and withdraws a retry row it created on a thread held later, but leaves user and other rows alone", async () => {
    const t = await setup();
    failedThread(t.core, "thr_mix", { failure: FAILURES.overloaded });
    await t.core.retry({ threadId: "thr_mix", sendAt: t.core.now + 5_000, reason: "Provider overloaded" });
    t.core.queue.push({ ...t.core.queue[0]!, id: "qmsg_user", payload: { kind: "inline" } });
    await t.core.retry({ threadId: "thr_mix", sendAt: t.core.now + 5_000, reason: "Manual retry" }).catch(() => undefined);
    // Hold through the plugin removes only its own row.
    await t.host.harness.runCli(["hold", "thr_mix"]);
    expect(t.core.queue.map((row) => row.id)).toEqual(["qmsg_user"]);
  });
});

describe("Claude turns with background work", () => {
  // Redacted replica of the live trace (2026-10-24, one client request): request → accepted →
  // local_bash started → reply → turn/completed(completed) → background task completed →
  // provider turn/started without a client request → more background work → ten CLI retries
  // (willRetry, internal/502) → final "Account Pooler could not reach Anthropic" → turn/completed(failed).
  function liveShape(core: FakeCore, id: string) {
    core.addThread({ id, providerId: "claude-code" });
    core.startTurn(id, { input: [{ type: "text", text: "task", mentions: [] }], execution: OPUS_ULTRACODE });
    const bg = core.startBackgroundTask(id, "local_bash");
    core.append(id, "item/completed", { item: { id: "msg-1", type: "agentMessage" } });
    core.append(id, "turn/completed", { status: "completed" });
    core.append(id, "item/backgroundTask/completed", { item: { id: bg, type: "backgroundTask", status: "completed", taskType: "local_bash" } });
    core.append(id, "turn/started", {});
    for (let n = 1; n <= 10; n++) {
      core.append(id, "provider/error", {
        message: "Provider error",
        detail: `Claude Code API retry ${n}/10 after 30000ms: HTTP 502 server_error`,
        willRetry: true,
        errorInfo: { category: "internal", providerCode: "server_error", httpStatusCode: 502 },
      });
    }
    core.failTurn(id, FAILURES.claudePooler);
  }

  it("resumes the live shape: a follow-on provider turn failed under an unchanged client request", async () => {
    const t = await setup();
    liveShape(t.core, "thr_bg");
    const request = t.core.lastRequest("thr_bg")!.data;
    expect(entry(await t.scan(), "thr_bg")?.state).toBe("resumed");
    // Core admitted it as a native retry of that request (turn-retry.ts rules): attempt 2,
    // accepted input → agent-only "Please continue.", same execution.
    const retry = t.core.lastRequest("thr_bg")!.data;
    expect(retry.retryOfRequestId).toBe(request.requestId);
    expect(retry.retryAttempt).toBe(2);
    expect(retry.execution).toEqual(OPUS_ULTRACODE);
    expect(retry.input).toEqual([{ type: "text", text: CONTINUE_ACCEPTED_TURN_TEXT, mentions: [], visibility: "agent-only" }]);
  });

  it("re-reads a cached failure when a later provider turn under the same request failed, even with no turn.failed", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_cache", providerId: "claude-code" });
    t.core.startTurn("thr_cache", { input: [], execution: OPUS_ULTRACODE });
    t.core.failTurn("thr_cache", FAILURES.unauthorized);
    expect(entry(await t.scan(), "thr_cache")?.reason).toBe("not-transport:unauthorized"); // cached
    t.core.append("thr_cache", "turn/started", {});
    t.core.append("thr_cache", "turn/completed", { status: "completed" });
    t.core.append("thr_cache", "turn/started", {});
    t.core.failTurn("thr_cache", FAILURES.claudePooler);
    expect(entry(await t.scan(), "thr_cache")?.state).toBe("resumed");
  });

  it("does not pick an older failed provider turn when a later one under the same request succeeded", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_later", providerId: "claude-code" });
    t.core.startTurn("thr_later", { input: [], execution: OPUS_ULTRACODE });
    t.core.failTurn("thr_later", FAILURES.claudePooler);
    t.core.append("thr_later", "turn/started", {});
    t.core.append("thr_later", "turn/completed", { status: "completed" });
    expect(entry(await t.scan(), "thr_later")).toMatchObject({ state: "skipped", reason: "latest-turn-completed" });
    expect(t.retries()).toEqual([]);
  });

  it("decides by the failed provider turn's own error, not an earlier turn's", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_own", providerId: "claude-code" });
    t.core.startTurn("thr_own", { input: [], execution: OPUS_ULTRACODE });
    t.core.append("thr_own", "provider/error", { message: "Provider error", detail: FAILURES.claudePooler.detail, errorInfo: FAILURES.claudePooler.errorInfo });
    t.core.append("thr_own", "turn/completed", { status: "completed" });
    t.core.append("thr_own", "turn/started", {});
    // The failed provider turn reported no error of its own: it must not inherit the earlier one.
    t.core.append("thr_own", "turn/completed", { status: "failed" });
    t.core.setThread("thr_own", { status: "error" });
    expect(entry(await t.scan(), "thr_own")?.reason).toBe("no-provider-error");
  });
});
