// The stalled-turn watchdog, the continuation check and the unfinished-request
// follow-up, against the same fake core as the connectivity tests. The shapes
// are the ones seen in production (2026-10-27/28): a turn silent for half an
// hour while the Mac was awake, a resumed manager that answered "Продолжаю…"
// after a few commands and stopped, and an automation run that failed at 502
// and was superseded four seconds later by a child-failed notification, so it
// was never retried.
import { describe, expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import { NUDGE_TAG, STALL_TAG, UNFINISHED_TAG } from "../src/continuations.js";
import { looksLikeOnlyAPromise } from "../src/follow-ups.js";
import type { WatchdogReport } from "../src/watchdog.js";
import { CODEX_HIGH, FAILURES, FakeCore, OPUS_ULTRACODE, type Execution } from "./fake-core.js";

const MINUTE = 60_000;

async function setup(options: { armed?: boolean } = {}) {
  const core = new FakeCore();
  let mono = 0;
  const host = createFakePluginHost({ pluginId: "provider-retry-advanced", sdk: core.sdk() as never });
  await createPlugin({
    probe: async () => ({ reachable: true, detail: "HTTP 405" }),
    now: () => core.now,
    monotonic: () => mono,
    wait: async () => {},
  })(host.bb);
  // All three are off by default; these tests turn them on, as an operator would.
  await host.harness.setSettings({ stallWatchdog: "20 minutes", continuationCheck: true, unfinishedFollowUp: true });
  core.hook = (context) => host.harness.registrations.hooks["message.dispatch"]!(context as never);
  core.onRowCancelled = (row) => host.harness.behavior.emitThreadEvent("message.cancelled", { entry: row } as never);
  if (options.armed !== false) expect((await host.harness.runCli(["arm"])).exitCode).toBe(0);
  const watchdog = async (): Promise<WatchdogReport> => {
    const result = await host.harness.runCli(["watchdog", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as WatchdogReport;
  };
  return {
    core,
    host,
    watchdog,
    /** Awake time: both clocks move, one check per minute, like the real service. */
    async awake(minutes: number): Promise<WatchdogReport> {
      let report: WatchdogReport | null = null;
      for (let i = 0; i < minutes; i++) {
        core.now += MINUTE;
        mono += MINUTE;
        report = await watchdog();
      }
      return report!;
    },
    /** The Mac sleeps: the wall clock moves, the monotonic clock does not. */
    sleep(minutes: number) {
      core.now += minutes * MINUTE;
      mono += 1_000;
    },
    stops: () => host.harness.inspection.sdk.callsTo("threads.stop"),
    sends: () => host.harness.inspection.sdk.callsTo("threads.send"),
    idle: async (threadId: string, text: string) => {
      const payload = core.reply(threadId, text);
      const { errors } = await host.harness.behavior.emitThreadEvent("thread.idle", payload as never);
      expect(errors).toEqual([]);
    },
    failed: async (threadId: string, failure: { errorInfo: Record<string, unknown> }, inputAccepted = true) => {
      const { errors } = await host.harness.behavior.emitThreadEvent("turn.failed", {
        threadId,
        requestId: core.lastRequest(threadId)!.data.requestId as string,
        turnId: null,
        errorInfo: failure.errorInfo,
        inputAccepted,
        rateLimits: null,
        attemptNumber: 1,
      } as never);
      expect(errors).toEqual([]);
    },
  };
}

function running(core: FakeCore, id: string, execution: Execution = OPUS_ULTRACODE, providerId = "claude-code") {
  core.addThread({ id, providerId });
  core.startTurn(id, { input: [{ type: "text", text: "Build the feature", mentions: [] }], execution });
}

function lastInput(core: FakeCore, id: string) {
  return core.lastRequest(id)!.data.input as Array<{ text: string; visibility?: string }>;
}

function entry(report: WatchdogReport, threadId: string) {
  return report.entries.find((e) => e.threadId === threadId);
}

describe("stalled-turn watchdog", () => {
  it("stops a turn that sent nothing for 20 awake minutes and continues it once, the way it ran", async () => {
    const t = await setup();
    running(t.core, "thr_quiet");
    expect((await t.awake(19)).entries).toEqual([]);
    expect(t.stops()).toEqual([]);

    const report = await t.awake(1);
    expect(entry(report, "thr_quiet")).toMatchObject({ state: "restarted", reason: "restarted", quietMinutes: 20 });
    expect(t.stops()).toEqual([[{ threadId: "thr_quiet" }]]);
    const input = lastInput(t.core, "thr_quiet");
    expect(input[0]!.text.startsWith(STALL_TAG)).toBe(true);
    expect(input[0]!.text).toContain("no progress for 20 minutes");
    expect(input[0]!.visibility).toBe("agent-only");
    expect(t.core.lastRequest("thr_quiet")!.data.execution).toEqual(OPUS_ULTRACODE);
    expect(t.core.thread("thr_quiet").status).toBe("active");
    expect((await t.host.harness.runCli(["explain", "thr_quiet"])).stdout).toContain("Stalled turn restarted");

    // The restarted turn stalls too: it is left alone, a person decides.
    const again = await t.awake(25);
    expect(entry(again, "thr_quiet")?.reason).toBe("already-restarted-once");
    expect(t.stops()).toHaveLength(1);
    expect(t.sends()).toHaveLength(1);
  });

  it("does not count time the Mac slept", async () => {
    const t = await setup();
    running(t.core, "thr_night");
    t.sleep(16 * 60);
    // The first check after the wake notices the sleep and counts from there.
    expect(entry(await t.awake(1), "thr_night")).toBeUndefined();
    expect((await t.awake(19)).entries).toEqual([]);
    expect(entry(await t.awake(1), "thr_night")?.state).toBe("restarted");
  });

  it("restarts the clock on every event", async () => {
    const t = await setup();
    running(t.core, "thr_busy");
    await t.awake(15);
    t.core.append("thr_busy", "provider/rateLimits/updated", {});
    expect((await t.awake(15)).entries).toEqual([]);
    expect(t.stops()).toEqual([]);
  });

  it("never touches a turn waiting for the user, running a tool or background work, held, owned by BB Workflows", async () => {
    const t = await setup();
    running(t.core, "thr_approval");
    t.core.setThread("thr_approval", { hasPendingInteraction: true });
    running(t.core, "thr_tool");
    t.core.startItem("thr_tool", "commandExecution");
    running(t.core, "thr_bg");
    t.core.startBackgroundTask("thr_bg", "local_workflow");
    running(t.core, "thr_held");
    running(t.core, "thr_worker");
    t.core.setThread("thr_worker", { originPluginId: "workflows", visibility: "hidden" });
    expect((await t.host.harness.runCli(["hold", "thr_held"])).exitCode).toBe(0);

    const report = await t.awake(30);
    expect(t.stops()).toEqual([]);
    expect(t.sends()).toEqual([]);
    expect(entry(report, "thr_approval")?.reason).toBe("waiting-for-user");
    expect(entry(report, "thr_tool")?.reason).toBe("tool-running:commandExecution");
    expect(entry(report, "thr_bg")?.reason).toBe("background-work-open");
    expect(entry(report, "thr_held")?.reason).toBe("held");
    expect(entry(report, "thr_worker")?.reason).toBe("workflow-engine-owned");
  });

  it("counts a stream that stopped mid-reply as stalled, and a finished tool as no excuse", async () => {
    const t = await setup();
    running(t.core, "thr_stream");
    t.core.startItem("thr_stream", "reasoning");
    const tool = t.core.startItem("thr_stream", "commandExecution");
    t.core.completeItem("thr_stream", tool, "commandExecution");
    expect(entry(await t.awake(20), "thr_stream")?.state).toBe("restarted");
  });

  it("only reports before arm", async () => {
    const t = await setup({ armed: false });
    running(t.core, "thr_new");
    expect(entry(await t.awake(20), "thr_new")?.reason).toBe("not-armed (run: bb provider-retry-advanced arm)");
    expect(t.stops()).toEqual([]);
  });

  it("sends the continue at a later check when the machine has not confirmed the stop yet", async () => {
    const t = await setup();
    running(t.core, "thr_slow");
    t.core.stopHangs = true;
    expect(entry(await t.awake(20), "thr_slow")?.reason).toBe("stop-not-settled");
    expect(t.sends()).toEqual([]);
    // The machine confirms: core settles the stopped turn.
    t.core.append("thr_slow", "turn/completed", { status: "interrupted" });
    t.core.interruptTurn("thr_slow", "manual-stop");
    expect(entry(await t.awake(1), "thr_slow")?.state).toBe("restarted");
    expect(t.sends()).toHaveLength(1);
    expect(t.stops()).toHaveLength(1);
  });

  it("drops the pending continue when someone else moved the thread on after the stop", async () => {
    const t = await setup();
    running(t.core, "thr_moved");
    t.core.stopHangs = true;
    expect(entry(await t.awake(20), "thr_moved")?.reason).toBe("stop-not-settled");
    t.core.interruptTurn("thr_moved", "manual-stop");
    t.core.startTurn("thr_moved", { input: [{ type: "text", text: "do this instead", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.completeTurn("thr_moved");
    expect(entry(await t.awake(1), "thr_moved")?.reason).toBe("stopped:thread-moved-on");
    expect((await t.awake(1)).entries).toEqual([]);
    expect(t.sends()).toEqual([]);
  });

  it("lets a queued message continue the stopped thread instead of adding a second one", async () => {
    const t = await setup();
    running(t.core, "thr_queue");
    await t.core.sdk().threads.send({ threadId: "thr_queue", input: [{ type: "text", text: "next", mentions: [] }], mode: "queue-if-active" });
    expect(entry(await t.awake(20), "thr_queue")?.reason).toBe("stopped:queued-message-continues");
    expect(t.sends()).toEqual([]);
  });

  it("is off with the setting", async () => {
    const t = await setup();
    await t.host.harness.setSettings({ stallWatchdog: "Off" });
    running(t.core, "thr_off");
    const report = await t.awake(30);
    expect(report.limitMinutes).toBeNull();
    expect(t.stops()).toEqual([]);
    expect((await t.host.harness.runCli(["status"])).stdout).toContain("Stall watchdog is off");
  });
});

describe("continuation check", () => {
  async function resumedThread(t: Awaited<ReturnType<typeof setup>>, id: string) {
    running(t.core, id);
    t.core.failTurn(id, FAILURES.claudePooler);
    expect((await t.host.harness.runCli(["scan"])).exitCode).toBe(0);
    expect(t.core.lastRequest(id)!.data.retryOfRequestId).toBeDefined();
  }

  it("answers a resumed turn that only said «Продолжу…» with one more continue, once", async () => {
    const t = await setup();
    await resumedThread(t, "thr_promise");
    await t.idle("thr_promise", "Продолжу плановый обзор с сохранённого состояния.");
    const input = lastInput(t.core, "thr_promise");
    expect(input[0]!.text.startsWith(NUDGE_TAG)).toBe(true);
    expect(input[0]!.visibility).toBe("agent-only");
    expect(t.core.lastRequest("thr_promise")!.data.execution).toEqual(OPUS_ULTRACODE);

    // The nudge's own turn promising again gets nothing more.
    await t.idle("thr_promise", "Продолжу с текущего состояния…");
    expect(t.sends()).toHaveLength(1);
    expect((await t.host.harness.runCli(["status", "thr_promise"])).stdout).toContain("continuation\tsent");
  });

  it("also answers the real shape: a few commands, then «Продолжаю… Проверю…» and the turn ends", async () => {
    const t = await setup();
    await resumedThread(t, "thr_few");
    for (let i = 0; i < 3; i++) t.core.completeItem("thr_few", t.core.startItem("thr_few", "commandExecution"), "commandExecution");
    await t.idle("thr_few", "Продолжаю с сохранённых результатов. Проверю, какие исполнители завершили работу.");
    expect(lastInput(t.core, "thr_few")[0]!.text.startsWith(NUDGE_TAG)).toBe(true);
  });

  it("leaves a resumed turn alone when it did real work, answered for real, waits for background work or child threads", async () => {
    const t = await setup();
    await resumedThread(t, "thr_tools");
    for (let i = 0; i < 6; i++) t.core.completeItem("thr_tools", t.core.startItem("thr_tools", "commandExecution"), "commandExecution");
    await t.idle("thr_tools", "Продолжу.");

    await resumedThread(t, "thr_parent");
    running(t.core, "thr_child");
    t.core.setThread("thr_child", { parentThreadId: "thr_parent" });
    await t.idle("thr_parent", "Продолжаю: воркер в работе, жду его уведомления.");

    await resumedThread(t, "thr_answer");
    await t.idle("thr_answer", "Готово: обзор закончен, два решения ждут тебя в заметке. Продолжу завтра по расписанию.");

    await resumedThread(t, "thr_waiting");
    t.core.startBackgroundTask("thr_waiting", "local_workflow");
    await t.idle("thr_waiting", "Продолжу, когда workflow закончится.");

    expect(t.sends()).toEqual([]);
    const reasons = (await t.host.harness.runCli(["status", "--json"])).stdout;
    expect(reasons).toContain("did-real-work");
    expect(reasons).toContain("waiting-for-child-threads");
    expect(reasons).toContain("background-work-open");
  });

  it("does not nudge a person's own turn", async () => {
    const t = await setup();
    running(t.core, "thr_user");
    await t.idle("thr_user", "Продолжу завтра.");
    expect(t.sends()).toEqual([]);
  });

  it("also checks the turn a stall restart started", async () => {
    const t = await setup();
    running(t.core, "thr_restarted");
    await t.awake(20);
    await t.idle("thr_restarted", "I'll continue from where I stopped.");
    expect(lastInput(t.core, "thr_restarted")[0]!.text.startsWith(NUDGE_TAG)).toBe(true);
  });

  it("is off with the setting", async () => {
    const t = await setup();
    await t.host.harness.setSettings({ continuationCheck: false });
    await resumedThread(t, "thr_off");
    await t.idle("thr_off", "Продолжу.");
    expect(t.sends()).toEqual([]);
  });

  it("matches only a reply that opens with a promise to continue", () => {
    for (const yes of ["Продолжу плановый обзор с сохранённого состояния.", "Продолжаю.", "Ок, продолжу", "**Продолжаю** с проверки", "Continuing with step 3.", "I'll continue now.", "Resuming the review."]) {
      expect(looksLikeOnlyAPromise(yes), yes).toBe(true);
    }
    for (const no of [null, "", "Готово: всё сделано, продолжу завтра.", "Продолжили. Нашлась проблема в патче.", "Продолжение уже идёт: изменения прошли проверки.", "The build passed; you can continue.", `Продолжу. ${"x".repeat(500)}`]) {
      expect(looksLikeOnlyAPromise(no), String(no)).toBe(false);
    }
  });
});

describe("unfinished request follow-up", () => {
  async function supersededAutomation(t: Awaited<ReturnType<typeof setup>>, id: string, accepted = true) {
    t.core.addThread({ id, providerId: "codex" });
    t.core.startTurn(id, {
      input: [{ type: "text", text: "[bb automation due:auto_review]\n\nReload registry and review the zone.", mentions: [] }],
      execution: CODEX_HIGH,
      accepted,
    });
    t.core.failTurn(id, FAILURES.codexPooler);
    await t.failed(id, FAILURES.codexPooler, accepted);
    t.core.startTurn(id, {
      input: [{ type: "text", text: "[bb system]\n\n@thread:thr_child failed.", mentions: [] }],
      execution: CODEX_HIGH,
      initiator: "system",
    });
  }

  it("sends a superseded automation run back once when the thread is idle", async () => {
    const t = await setup();
    await supersededAutomation(t, "thr_mgr");
    await t.idle("thr_mgr", "Ребёнок упал, перезапущу позже.");
    const input = lastInput(t.core, "thr_mgr");
    expect(input[0]!.text.startsWith(UNFINISHED_TAG)).toBe(true);
    expect(input[0]!.text).toContain("an automation run");
    expect(input[0]!.text).not.toContain("The request was:"); // accepted: already in the provider session
    expect(input[0]!.visibility).toBe("agent-only");
    expect(t.core.lastRequest("thr_mgr")!.data.execution).toEqual(CODEX_HIGH);

    await t.idle("thr_mgr", "Готово.");
    expect(t.sends()).toHaveLength(1);
  });

  it("repeats the request text when the provider never accepted it", async () => {
    const t = await setup();
    await supersededAutomation(t, "thr_door", false);
    await t.idle("thr_door", "Ок.");
    expect(lastInput(t.core, "thr_door")[0]!.text).toContain("The request was:\n\n[bb automation due:auto_review]");
  });

  it("does nothing when the failure was retried and finished, or a person wrote after it", async () => {
    const t = await setup();
    // Retried by connectivity recovery and finished; a notification came after.
    t.core.addThread({ id: "thr_retried", providerId: "codex" });
    t.core.startTurn("thr_retried", { input: [{ type: "text", text: "[bb automation due:auto_x]", mentions: [] }], execution: CODEX_HIGH });
    t.core.failTurn("thr_retried", FAILURES.codexPooler);
    await t.failed("thr_retried", FAILURES.codexPooler);
    await t.host.harness.runCli(["scan"]);
    t.core.reply("thr_retried", "Сделано.");
    t.core.startTurn("thr_retried", { input: [{ type: "text", text: "[bb system] child done", mentions: [] }], execution: CODEX_HIGH, initiator: "system" });
    await t.idle("thr_retried", "Принял.");

    // Superseded, but then Sergey wrote a new message himself.
    await supersededAutomation(t, "thr_person");
    t.core.reply("thr_person", "Принял уведомление.");
    t.core.startTurn("thr_person", { input: [{ type: "text", text: "сделай другое", mentions: [] }], execution: CODEX_HIGH });
    await t.idle("thr_person", "Сделал другое.");

    expect(t.sends()).toEqual([]);
  });

  it("ignores failures no retry policy would retry and requests the system sent", async () => {
    const t = await setup();
    t.core.addThread({ id: "thr_auth", providerId: "claude-code" });
    t.core.startTurn("thr_auth", { input: [{ type: "text", text: "task", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.failTurn("thr_auth", FAILURES.unauthorized);
    await t.failed("thr_auth", FAILURES.unauthorized);
    t.core.startTurn("thr_auth", { input: [{ type: "text", text: "[bb system] note", mentions: [] }], execution: OPUS_ULTRACODE, initiator: "system" });
    await t.idle("thr_auth", "Ок.");

    t.core.addThread({ id: "thr_sys", providerId: "codex" });
    t.core.startTurn("thr_sys", { input: [{ type: "text", text: "[bb system] child failed", mentions: [] }], execution: CODEX_HIGH, initiator: "system" });
    t.core.failTurn("thr_sys", FAILURES.codexPooler);
    await t.failed("thr_sys", FAILURES.codexPooler);
    t.core.startTurn("thr_sys", { input: [{ type: "text", text: "[bb system] child completed", mentions: [] }], execution: CODEX_HIGH, initiator: "system" });
    await t.idle("thr_sys", "Ок.");

    expect(t.sends()).toEqual([]);
  });

  it("waits while the thread is held or not armed, and is off with the setting", async () => {
    const t = await setup();
    await supersededAutomation(t, "thr_hold");
    await t.host.harness.runCli(["hold", "thr_hold"]);
    await t.idle("thr_hold", "Ок.");
    expect(t.sends()).toEqual([]);

    await t.host.harness.setSettings({ unfinishedFollowUp: false });
    await supersededAutomation(t, "thr_setting");
    await t.idle("thr_setting", "Ок.");
    expect(t.sends()).toEqual([]);
  });
});
