import { describe, expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import { WORKFLOW_TAG, workflowText } from "../src/continuations.js";
import type { ScanReport } from "../src/recovery.js";
import { CONTINUE_ACCEPTED_TURN_TEXT, FakeCore, OPUS_ULTRACODE } from "./fake-core.js";

const PLUGIN_ID = "provider-retry-advanced";

type ListArgs = { threadId: string; types?: string[]; order?: string; beforeSeq?: string };

async function setup(options: { armed?: boolean; workflowRecovery?: boolean } = {}) {
  const core = new FakeCore();
  const sends: Array<Record<string, unknown>> = [];
  const sdk = core.sdk();
  const send = sdk.threads.send;
  const list = sdk.threads.events.list;
  // Test controls, read through closures because the harness wraps the SDK once.
  const hooks = {
    sendFails: null as null | "before" | "after",
    /** Runs when the plugin reads the thread's latest request: the last read before its send. */
    onLatestRequest: null as null | (() => Promise<void> | void),
  };
  sdk.threads.send = async (args) => {
    sends.push(args as never);
    if (hooks.sendFails === "before") throw new Error("temporary pre-admission failure");
    const result = await send(args);
    if (hooks.sendFails === "after") throw new Error("response lost after admission");
    return result;
  };
  sdk.threads.events.list = async (args) => {
    const rows = await list(args);
    const read = args as ListArgs;
    if (read.types?.includes("client/turn/requested") && read.order === "desc" && read.beforeSeq === undefined && hooks.onLatestRequest !== null) {
      await hooks.onLatestRequest();
    }
    return rows;
  };
  const factory = createPlugin({ probe: async () => ({ reachable: true, detail: "HTTP 405" }), now: () => core.now });
  let host = createFakePluginHost({ pluginId: PLUGIN_ID, sdk: sdk as never });
  const wire = async () => {
    if (options.workflowRecovery !== false) await host.harness.setSettings({ workflowRecovery: true });
    core.hook = (context) => host.harness.registrations.hooks["message.dispatch"]!(context as never);
    core.onRowCancelled = (row) => host.harness.behavior.emitThreadEvent("message.cancelled", { entry: row } as never);
  };
  await factory(host.bb);
  await wire();
  if (options.armed !== false) expect((await host.harness.runCli(["arm"])).exitCode).toBe(0);
  const t = {
    core,
    sends,
    hooks,
    run: (args: string[]) => host.harness.runCli(args),
    hook: () => host.harness.registrations.hooks["message.dispatch"]!,
    scan: async (): Promise<ScanReport> => {
      const result = await host.harness.runCli(["scan", "--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      core.now += 60_000;
      return JSON.parse(result.stdout) as ScanReport;
    },
    /** BB restarts: the plugin reloads with its stored state, core settles what the dead daemon left open. */
    restart: async (settle: () => void) => {
      host = await host.harness.lifecycle.reload(factory);
      await wire();
      settle();
    },
    /** Interrupted-workflow messages that reached the thread (dispatched turns). */
    delivered: (threadId: string) =>
      core.events.get(threadId)!.filter(
        (e) => e.type === "client/turn/requested" && JSON.stringify(e.data.input).includes(WORKFLOW_TAG),
      ),
    workflowSends: () => sends.filter((args) => JSON.stringify(args.input).includes(WORKFLOW_TAG)),
  };
  return t;
}

/** A Claude thread whose turn started an UltraCode workflow and then ended; the workflow keeps running. */
function workflowThread(core: FakeCore, id: string, name = "bb-plugins-page-design"): string {
  core.addThread({ id, providerId: "claude-code" });
  core.startTurn(id, { input: [{ type: "text", text: "Design the page", mentions: [] }], execution: OPUS_ULTRACODE });
  const item = core.startBackgroundTask(id, "local_workflow", name);
  core.completeTurn(id);
  return item;
}

/** A workflow killed by a restart, the plugin having seen it running first. */
async function killed(t: Awaited<ReturnType<typeof setup>>, id: string, name?: string): Promise<void> {
  workflowThread(t.core, id, name);
  await t.scan();
  t.core.settleBackgroundTasks(id);
}

/** A Claude thread whose turn started a workflow run through the Workflow tool, then ended. */
function workflowRun(core: FakeCore, id: string, name: string, runId: string): void {
  core.addThread({ id, providerId: "claude-code" });
  core.startTurn(id, { input: [{ type: "text", text: "Run it", mentions: [] }], execution: OPUS_ULTRACODE });
  core.startWorkflowRun(id, name, runId);
  core.completeTurn(id);
}

/** The message as core would have queued it (behind another plugin's wait, for example). */
function queueWorkflowMessage(core: FakeCore, threadId: string): void {
  const input = [{ type: "text", text: workflowText(["bb-plugins-page-design"]), mentions: [], visibility: "agent-only" }];
  core.queue.push({
    id: `qmsg_wf_${threadId}`,
    threadId,
    createdAt: core.now,
    failureReason: null,
    sendAt: null,
    state: "queued",
    waitingOn: { kind: "plugin" },
    payload: { kind: "inline" },
    input,
    content: input,
    execution: OPUS_ULTRACODE,
    retryOf: { requestId: "", attempt: 0 },
  });
}

function entry(report: ScanReport, threadId: string) {
  return report.entries.find((e) => e.threadId === threadId);
}

describe("Claude Code workflows a BB restart killed", () => {
  it("sends one message to resume the run, with the turn's model, effort, tier and permissions", async () => {
    const t = await setup();
    workflowThread(t.core, "thr_idle");
    await t.scan(); // sees the workflow running on the idle thread
    await t.restart(() => t.core.settleBackgroundTasks("thr_idle"));
    const report = await t.scan();
    expect(entry(report, "thr_idle")).toMatchObject({ state: "resumed", reason: "workflow:interrupted-workflow" });
    expect(t.workflowSends()).toHaveLength(1);
    expect(t.workflowSends()[0]).toMatchObject({
      threadId: "thr_idle",
      model: OPUS_ULTRACODE.model,
      reasoningLevel: OPUS_ULTRACODE.reasoningLevel,
      serviceTier: OPUS_ULTRACODE.serviceTier,
      permissionMode: OPUS_ULTRACODE.permissionMode,
    });
    const [message] = t.delivered("thr_idle");
    const input = message!.data.input as Array<{ text: string; visibility: string }>;
    expect(input[0]!.visibility).toBe("agent-only");
    expect(input[0]!.text).toContain('"bb-plugins-page-design"');
    expect(input[0]!.text).toContain("resumeFromRunId");
    expect(input[0]!.text).toContain("do not create a new run");
    expect(t.core.queue).toHaveLength(0);
  });

  it("does nothing with the setting at its default (off)", async () => {
    const t = await setup({ workflowRecovery: false });
    await killed(t, "thr_default");
    await t.scan();
    await t.scan();
    expect(t.sends).toHaveLength(0);
  });

  it("is idempotent across later scans and further restarts", async () => {
    const t = await setup();
    workflowThread(t.core, "thr_once");
    await t.scan();
    await t.restart(() => t.core.settleBackgroundTasks("thr_once"));
    await t.scan();
    t.core.completeTurn("thr_once");
    expect(entry(await t.scan(), "thr_once")?.reason).toBe("workflow:already-sent");
    await t.restart(() => t.core.settleBackgroundTasks("thr_once"));
    await t.scan();
    await t.scan();
    expect(t.delivered("thr_once")).toHaveLength(1);
  });

  it("never touches a workflow that is still running, across restarts of the plugin", async () => {
    const t = await setup();
    workflowThread(t.core, "thr_running");
    await t.scan();
    await t.restart(() => {}); // plugin reload only: the daemon and the workflow live on
    for (let i = 0; i < 3; i++) await t.scan();
    expect(t.sends).toHaveLength(0);
  });

  it("leaves workflows Claude Code finished or stopped itself", async () => {
    const t = await setup();
    const done = workflowThread(t.core, "thr_done");
    const stopped = workflowThread(t.core, "thr_taskstop");
    await t.scan();
    t.core.closeBackgroundTask("thr_done", done, "completed");
    t.core.closeBackgroundTask("thr_taskstop", stopped, "stopped");
    const report = await t.scan();
    expect(entry(report, "thr_done")?.reason).toBe("workflow:workflow-finished-or-resumed");
    expect(entry(report, "thr_taskstop")?.reason).toBe("workflow:workflow-finished-or-resumed");
    await t.scan();
    expect(t.sends).toHaveLength(0);
  });

  it("leaves a thread the user stopped", async () => {
    const t = await setup();
    workflowThread(t.core, "thr_stop");
    await t.scan();
    // A stop the machine could not confirm: core interrupts and settles itself.
    t.core.append("thr_stop", "system/thread/interrupted", { reason: "manual-stop" });
    t.core.settleBackgroundTasks("thr_stop");
    expect(entry(await t.scan(), "thr_stop")?.reason).toBe("workflow:stopped-by-user");
    expect(t.sends).toHaveLength(0);
  });

  it("leaves held threads and threads someone wrote to since", async () => {
    const t = await setup();
    workflowThread(t.core, "thr_held");
    workflowThread(t.core, "thr_user");
    await t.scan();
    expect((await t.run(["hold", "thr_held"])).exitCode).toBe(0);
    await t.restart(() => {
      t.core.settleBackgroundTasks("thr_held");
      t.core.settleBackgroundTasks("thr_user");
    });
    t.core.startTurn("thr_user", { input: [{ type: "text", text: "Status?", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.completeTurn("thr_user");
    const report = await t.scan();
    expect(entry(report, "thr_held")).toBeUndefined(); // the hold dropped the marker
    expect(entry(report, "thr_user")?.reason).toBe("workflow:a-newer-message-took-over");
    expect((await t.run(["release", "thr_held"])).exitCode).toBe(0);
    await t.scan();
    expect(t.sends).toHaveLength(0);
  });

  it("waits for an approval and for arm, then sends once", async () => {
    const t = await setup({ armed: false });
    workflowThread(t.core, "thr_wait");
    await t.scan();
    await t.restart(() => t.core.settleBackgroundTasks("thr_wait"));
    t.core.setThread("thr_wait", { hasPendingInteraction: true });
    expect(entry(await t.scan(), "thr_wait")).toMatchObject({ state: "waiting", reason: "workflow:pending-interaction" });
    t.core.setThread("thr_wait", { hasPendingInteraction: false });
    expect(entry(await t.scan(), "thr_wait")?.state).toBe("waiting");
    expect(t.sends).toHaveLength(0);
    expect((await t.run(["arm"])).exitCode).toBe(0);
    expect(t.delivered("thr_wait")).toHaveLength(1);
  });

  it("retries a turn the restart interrupted first, then asks to resume the workflow once", async () => {
    const t = await setup();
    const id = "thr_active";
    t.core.addThread({ id, providerId: "claude-code", environmentHostId: "host_remote" });
    t.core.startTurn(id, { input: [{ type: "text", text: "Design the page", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startBackgroundTask(id, "local_workflow", "page-review");
    await t.scan();
    // The machine is gone: core interrupts the running turn and settles the workflow.
    await t.core.setHostOnline("host_remote", false);
    t.core.interruptTurn(id, "host-daemon-restarted", "host-connection-lost");
    t.core.settleBackgroundTasks(id);
    let report = await t.scan();
    expect(t.core.queue).toHaveLength(1); // core's retry waits for the machine
    expect(report.entries.filter((e) => e.threadId === id).map((e) => e.reason)).toContain("workflow:thread-error");
    await t.scan();
    expect(t.core.queue).toHaveLength(1); // no second retry while one is queued
    await t.core.setHostOnline("host_remote", true);
    expect(JSON.stringify(t.core.lastRequest(id)!.data.input)).toContain(CONTINUE_ACCEPTED_TURN_TEXT);
    report = await t.scan();
    expect(entry(report, id)?.reason).toBe("workflow:thread-active");
    t.core.completeTurn(id);
    await t.scan();
    await t.scan();
    expect(t.delivered(id)).toHaveLength(1);
    expect(JSON.stringify(t.delivered(id)[0]!.data.input)).toContain("page-review");
  });

  it("does not ask again when the agent already resumed the workflow", async () => {
    const t = await setup();
    const id = "thr_relaunch";
    t.core.addThread({ id, providerId: "claude-code", environmentHostId: "host_remote" });
    t.core.startTurn(id, { input: [{ type: "text", text: "Design the page", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startWorkflowRun(id, "page-review", "wf_page0001-001");
    await t.scan();
    t.core.interruptTurn(id, "host-daemon-restarted");
    t.core.settleBackgroundTasks(id);
    await t.scan(); // core retry: "Please continue."
    const resumed = t.core.startWorkflowRun(id, "page-review", "wf_page0001-001", "wf_page0001-001");
    t.core.completeTurn(id);
    await t.scan();
    t.core.closeBackgroundTask(id, resumed, "completed");
    await t.scan();
    expect(t.workflowSends()).toHaveLength(0);
  });
});

describe("review cases: interrupted-workflow message and the dispatch gate", () => {
  it("a hold placed during the last checks stops the send at the hook", async () => {
    const t = await setup();
    await killed(t, "thr_r1");
    t.hooks.onLatestRequest = async () => {
      t.hooks.onLatestRequest = null;
      await t.run(["hold", "thr_r1"]);
    };
    await t.scan();
    expect(t.delivered("thr_r1")).toHaveLength(0);
    expect(t.core.thread("thr_r1").status).toBe("idle");
    await t.scan();
    expect(t.delivered("thr_r1")).toHaveLength(0);
  });

  it("a workflow resumed during the last checks gets no second resume request", async () => {
    const t = await setup();
    workflowRun(t.core, "thr_r2", "original", "wf_orig0002-002");
    await t.scan();
    t.core.settleBackgroundTasks("thr_r2");
    let resumed = "";
    t.hooks.onLatestRequest = () => {
      t.hooks.onLatestRequest = null;
      t.core.startTurn("thr_r2", { input: [{ type: "text", text: "Background callback", mentions: [] }], execution: OPUS_ULTRACODE, initiator: "system" });
      resumed = t.core.startWorkflowRun("thr_r2", "original", "wf_orig0002-002", "wf_orig0002-002");
      t.core.completeTurn("thr_r2");
    };
    expect(entry(await t.scan(), "thr_r2")?.reason).toBe("workflow:send-failed"); // the hook saw the thread move on
    expect(entry(await t.scan(), "thr_r2")).toBeUndefined(); // workflow open again: wait
    t.core.closeBackgroundTask("thr_r2", resumed, "completed");
    expect(entry(await t.scan(), "thr_r2")?.reason).toBe("workflow:workflow-finished-or-resumed");
    expect(t.delivered("thr_r2")).toHaveLength(0);
  });

  it("a thread that turned busy during the last checks gets no queued message; the next idle scan sends it", async () => {
    const t = await setup();
    await killed(t, "thr_r3");
    t.hooks.onLatestRequest = () => {
      t.hooks.onLatestRequest = null;
      t.core.setThread("thr_r3", { status: "active" });
    };
    expect(entry(await t.scan(), "thr_r3")?.reason).toBe("workflow:send-failed");
    expect(t.core.queue).toHaveLength(0);
    await t.scan();
    expect(entry(await t.scan(), "thr_r3")?.reason).toBe("workflow:thread-active");
    t.core.completeTurn("thr_r3");
    await t.scan();
    expect(t.delivered("thr_r3")).toHaveLength(1);
  });

  it("a queued message is withdrawn by a hold and never drains", async () => {
    const t = await setup();
    await killed(t, "thr_q1");
    queueWorkflowMessage(t.core, "thr_q1");
    await t.run(["hold", "thr_q1"]);
    expect(t.core.queue).toHaveLength(0);
    await t.core.drain();
    expect(t.delivered("thr_q1")).toHaveLength(0);
  });

  it("a queued message drains only after the checks pass again", async () => {
    const t = await setup();
    await killed(t, "thr_q2");
    queueWorkflowMessage(t.core, "thr_q2");
    await t.core.drain();
    expect(t.delivered("thr_q2")).toHaveLength(0); // waits for the re-check
    await Bun.sleep(0);
    await Bun.sleep(0);
    t.core.now = t.core.queue[0]!.sendAt! + 1;
    await t.core.drain();
    expect(t.delivered("thr_q2")).toHaveLength(1);
  });

  it("a queued message is withdrawn when someone wrote to the thread since the kill", async () => {
    const t = await setup();
    await killed(t, "thr_q3");
    t.core.startTurn("thr_q3", { input: [{ type: "text", text: "Status?", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.completeTurn("thr_q3");
    queueWorkflowMessage(t.core, "thr_q3");
    await t.core.drain();
    for (let i = 0; i < 5 && t.core.queue.length > 0; i++) await Bun.sleep(0);
    expect(t.core.queue).toHaveLength(0);
    expect(t.delivered("thr_q3")).toHaveLength(0);
  });

  it("deleting the queued message drops the recovery", async () => {
    const t = await setup();
    await killed(t, "thr_q4");
    queueWorkflowMessage(t.core, "thr_q4");
    await t.core.sdk().threads.queuedMessages.delete({ threadId: "thr_q4", queuedMessageId: "qmsg_wf_thr_q4" });
    await t.scan();
    await t.scan();
    expect(t.sends).toHaveLength(0);
  });
});

describe("review cases: failed sends, several workflows, cancel", () => {
  it("keeps the marker when the send fails before admission and sends at the next scan, also after reload", async () => {
    const t = await setup();
    await killed(t, "thr_f1");
    t.hooks.sendFails = "before";
    expect(entry(await t.scan(), "thr_f1")?.reason).toBe("workflow:send-failed");
    t.hooks.sendFails = null;
    await t.restart(() => {});
    await t.scan();
    await t.scan();
    expect(t.workflowSends()).toHaveLength(2);
    expect(t.delivered("thr_f1")).toHaveLength(1);
  });

  it("an ambiguous send that did go out is not sent again", async () => {
    const t = await setup();
    await killed(t, "thr_f2");
    t.hooks.sendFails = "after";
    await t.scan();
    t.hooks.sendFails = null;
    t.core.completeTurn("thr_f2");
    expect(entry(await t.scan(), "thr_f2")?.reason).toBe("workflow:already-sent");
    await t.scan();
    expect(t.delivered("thr_f2")).toHaveLength(1);
  });

  it("a resumed and finished workflow B does not hide killed workflow A", async () => {
    const t = await setup();
    const id = "thr_ab";
    workflowRun(t.core, id, "A", "wf_aaaa0000-00a");
    t.core.startTurn(id, { input: [{ type: "text", text: "Also B", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startWorkflowRun(id, "B", "wf_bbbb0000-00b");
    await t.scan();
    t.core.interruptTurn(id, "host-daemon-restarted");
    t.core.settleBackgroundTasks(id);
    await t.scan(); // core retry first
    const b = t.core.startWorkflowRun(id, "B", "wf_bbbb0000-00b", "wf_bbbb0000-00b"); // the agent resumes only B
    t.core.completeTurn(id);
    expect(entry(await t.scan(), id)).toBeUndefined(); // B still running: wait
    t.core.closeBackgroundTask(id, b, "completed");
    await t.scan();
    expect(t.delivered(id)).toHaveLength(1);
    const text = JSON.stringify(t.delivered(id)[0]!.data.input);
    expect(text).toContain("wf_aaaa0000-00a");
    expect(text).not.toContain("wf_bbbb0000-00b");
  });

  it("an independent same-name workflow does not count as resuming a run whose id is unknown", async () => {
    const t = await setup();
    await killed(t, "thr_same", "review"); // no Workflow call result: run id unknown
    t.core.startTurn("thr_same", { input: [{ type: "text", text: "Callback", mentions: [] }], execution: OPUS_ULTRACODE, initiator: "system" });
    const other = t.core.startWorkflowRun("thr_same", "review", "wf_new00000-001"); // a new run, not a resume
    t.core.completeTurn("thr_same");
    await t.scan();
    t.core.closeBackgroundTask("thr_same", other, "completed");
    await t.scan();
    expect(t.delivered("thr_same")).toHaveLength(1);
    const text = JSON.stringify(t.delivered("thr_same")[0]!.data.input);
    expect(text).toContain("run id unknown");
    expect(text).not.toContain("wf_new00000-001");
  });

  it("does not send, and keeps the marker, when the workflow's request chain cannot be read", async () => {
    const t = await setup();
    await killed(t, "thr_pruned");
    // History before the close is gone: the workflow's start (and its request) cannot be found.
    const events = t.core.events.get("thr_pruned")!;
    t.core.events.set("thr_pruned", events.filter((e) => e.type !== "item/started" && e.type !== "client/turn/requested"));
    expect(entry(await t.scan(), "thr_pruned")).toMatchObject({ state: "waiting", reason: "workflow:workflow-origin-unknown" });
    expect(entry(await t.scan(), "thr_pruned")?.reason).toBe("workflow:workflow-origin-unknown");
    expect(t.sends).toHaveLength(0);
  });

  it("links a resume by the Workflow call's resumeFromRunId, not by name", async () => {
    const t = await setup();
    const id = "thr_runs";
    t.core.addThread({ id, providerId: "claude-code" });
    t.core.startTurn(id, { input: [{ type: "text", text: "Two reviews", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startWorkflowRun(id, "review", "wf_aaaa1111-001");
    t.core.startWorkflowRun(id, "review", "wf_bbbb2222-002");
    t.core.completeTurn(id);
    await t.scan();
    t.core.settleBackgroundTasks(id);
    // A system turn resumes only the second run by id, and it finishes.
    t.core.startTurn(id, { input: [{ type: "text", text: "Callback", mentions: [] }], execution: OPUS_ULTRACODE, initiator: "system" });
    const resumed = t.core.startWorkflowRun(id, "review", "wf_bbbb2222-002", "wf_bbbb2222-002");
    t.core.completeTurn(id);
    await t.scan();
    t.core.closeBackgroundTask(id, resumed, "completed");
    await t.scan();
    expect(t.delivered(id)).toHaveLength(1);
    const text = JSON.stringify(t.delivered(id)[0]!.data.input);
    expect(text).toContain("wf_aaaa1111-001");
    expect(text).not.toContain("wf_bbbb2222-002");
  });

  it("asks again about a run that was resumed and then killed by a second restart", async () => {
    const t = await setup();
    const id = "thr_twice";
    t.core.addThread({ id, providerId: "claude-code" });
    t.core.startTurn(id, { input: [{ type: "text", text: "Review", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startWorkflowRun(id, "review", "wf_cccc3333-003");
    t.core.completeTurn(id);
    await t.scan();
    t.core.settleBackgroundTasks(id);
    await t.scan(); // first message
    expect(t.delivered(id)).toHaveLength(1);
    t.core.startWorkflowRun(id, "review", "wf_cccc3333-003", "wf_cccc3333-003"); // the agent resumes it
    t.core.completeTurn(id);
    await t.scan();
    t.core.settleBackgroundTasks(id); // a second restart kills the resumed run
    await t.scan();
    expect(t.delivered(id)).toHaveLength(2);
    expect(JSON.stringify(t.delivered(id)[1]!.data.input)).toContain("wf_cccc3333-003");
  });

  it("finds the killed workflow behind more than a page of other background closes", async () => {
    const t = await setup();
    workflowThread(t.core, "thr_many");
    await t.scan();
    t.core.settleBackgroundTasks("thr_many");
    for (let i = 0; i < 250; i++) {
      const command = t.core.startBackgroundTask("thr_many", "local_bash");
      t.core.closeBackgroundTask("thr_many", command, "completed");
    }
    await t.scan();
    expect(t.delivered("thr_many")).toHaveLength(1);
  });

  it("a cancel of the interrupted turn drops its workflows, but not a later independent one", async () => {
    const t = await setup();
    const id = "thr_cancel";
    t.core.addThread({ id, providerId: "claude-code" });
    t.core.startTurn(id, { input: [{ type: "text", text: "Go on", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startBackgroundTask(id, "local_workflow", "page-review"); // started by the turn that is cancelled
    await t.scan();
    t.core.interruptTurn(id, "host-daemon-restarted");
    t.core.settleBackgroundTasks(id);
    expect((await t.run(["cancel", id])).exitCode).toBe(0);
    expect(entry(await t.scan(), id)?.reason).toBe("workflow:cancelled");
    expect(t.core.thread(id).status).toBe("error"); // no transport retry after cancel
    // A system notification runs a turn and leaves the thread idle.
    t.core.startTurn(id, { input: [{ type: "text", text: "Child finished", mentions: [] }], execution: OPUS_ULTRACODE, initiator: "system" });
    t.core.completeTurn(id);
    await t.scan();
    expect(t.delivered(id)).toHaveLength(0);
    // Later the user starts new work; its workflow is killed by another restart.
    t.core.startTurn(id, { input: [{ type: "text", text: "New task", mentions: [] }], execution: OPUS_ULTRACODE });
    t.core.startBackgroundTask(id, "local_workflow", "new-task");
    t.core.completeTurn(id);
    await t.scan();
    t.core.settleBackgroundTasks(id);
    await t.scan();
    expect(t.delivered(id)).toHaveLength(1);
    expect(JSON.stringify(t.delivered(id)[0]!.data.input)).toContain("new-task");
  });
});
