import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Messages this plugin sends itself (stalled-turn restart, continuation
 * nudge, unfinished-request follow-up) start with this tag. They are
 * agent-only, so the user's transcript is unchanged, and the tag is how the
 * plugin recognises its own continuations later: it never answers one of its
 * own messages with another.
 */
export const OWN_MESSAGE_TAG = "[bb provider-retry-advanced";
export const STALL_TAG = `${OWN_MESSAGE_TAG}: stalled turn]`;
export const NUDGE_TAG = `${OWN_MESSAGE_TAG}: continue]`;
export const UNFINISHED_TAG = `${OWN_MESSAGE_TAG}: unfinished request]`;
export const WORKFLOW_TAG = `${OWN_MESSAGE_TAG}: interrupted workflow]`;

const CHECK_STATE_HINT =
  "Before re-running anything you started (commands, child threads, workflows), check its current state. Resume an interrupted BB workflow with `bb workflows run … --resume <run-id>`; restart an interrupted Claude Code workflow from its last finished step.";

export function stallText(minutes: number): string {
  return `${STALL_TAG} Your previous turn made no progress for ${minutes} minutes and was stopped automatically. Continue the task from where it stopped. ${CHECK_STATE_HINT}`;
}

export const NUDGE_TEXT = `${NUDGE_TAG} After the automatic retry your turn ended on a note that you would continue, without finishing. Do the next steps of the task now instead of announcing them; end the turn only when the task is done or you are waiting for something specific, and say what. ${CHECK_STATE_HINT}`;

export function unfinishedText(args: { failedAt: number; automation: boolean; accepted: boolean; input: string }): string {
  const what = args.automation ? "an automation run" : "a message";
  const head = `${UNFINISHED_TAG} The request sent at ${new Date(args.failedAt).toISOString().slice(0, 16).replace("T", " ")} UTC (${what}) failed with a provider error before it finished, and later system notifications took its turn, so it was never completed. Finish that request now; check what was already done first. ${CHECK_STATE_HINT}`;
  // Input the provider never accepted is not in its session: repeat it, as core's own retry does.
  return args.accepted || args.input === "" ? head : `${head}\n\nThe request was:\n\n${args.input}`;
}

/**
 * Claude Code keeps a killed workflow's journal in its session: resuming the
 * run by id returns finished agents from cache and re-runs the ones that were
 * still running (checked with Claude Code 2.1.312 after SIGTERM).
 */
export function workflowText(labels: string[]): string {
  const list = labels.join(", ");
  return `${WORKFLOW_TAG} BB restarted while your Claude Code workflow ${list} was still running in the background, and the restart stopped it. First check that run's current status and what its interrupted steps already did outside the session (files, commands, messages, child threads). Then resume that same run with the Workflow tool and \`resumeFromRunId\` set to its run id (from the result of the Workflow call that started it), so agents that already finished return their cached results; agents that were mid-step run again. If the run or its journal is gone, say so and do not create a new run on your own. Then continue the task.`;
}

/** The execution a turn ran with; replayed so a continuation runs the way the turn ran. */
export interface Execution {
  model?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: string;
}

/** The fields of a `client/turn/requested` event this plugin reads. */
export interface TurnRequest {
  seq: number;
  createdAt: number;
  requestId: string;
  retryOfRequestId: string | null;
  /** `user` (a person or an automation), `agent` (another thread), `system` (notifications, retries). */
  initiator: string | null;
  text: string;
  execution: Execution | null;
}

interface RawEvent {
  seq: number;
  type: string;
  createdAt?: number;
  data: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseRequest(event: RawEvent): TurnRequest {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const input = Array.isArray(data.input) ? (data.input as Array<Record<string, unknown>>) : [];
  const text = input
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  const exec = (data.execution ?? null) as Record<string, unknown> | null;
  return {
    seq: event.seq,
    createdAt: typeof event.createdAt === "number" ? event.createdAt : 0,
    requestId: str(data.requestId) ?? "",
    retryOfRequestId: str(data.retryOfRequestId) ?? null,
    initiator: str(data.initiator) ?? null,
    text,
    execution:
      exec === null
        ? null
        : {
            ...(str(exec.model) === undefined ? {} : { model: str(exec.model) }),
            ...(str(exec.reasoningLevel) === undefined ? {} : { reasoningLevel: str(exec.reasoningLevel) }),
            ...(str(exec.serviceTier) === undefined ? {} : { serviceTier: str(exec.serviceTier) }),
            ...(str(exec.permissionMode) === undefined ? {} : { permissionMode: str(exec.permissionMode) }),
          },
  };
}

export function isOwnMessage(request: TurnRequest): boolean {
  return request.text.startsWith(OWN_MESSAGE_TAG);
}

/** Core's own retry ("Please continue." or the re-sent input), from this plugin or the bundled policy. */
export function isAutomaticRetry(request: TurnRequest): boolean {
  return request.retryOfRequestId !== null && request.initiator === "system";
}

type EventsList = BbPluginApi["sdk"]["threads"]["events"]["list"];

export async function listEvents(
  bb: BbPluginApi,
  args: { threadId: string; types?: string[]; afterSeq?: number; beforeSeq?: number; order: "asc" | "desc"; limit: number },
): Promise<RawEvent[]> {
  const list = bb.sdk.threads.events.list as unknown as (input: Record<string, unknown>) => ReturnType<EventsList>;
  return (await list({
    threadId: args.threadId,
    ...(args.types === undefined ? {} : { types: args.types }),
    ...(args.afterSeq === undefined ? {} : { afterSeq: String(args.afterSeq) }),
    ...(args.beforeSeq === undefined ? {} : { beforeSeq: String(args.beforeSeq) }),
    order: args.order,
    limit: String(args.limit),
  })) as unknown as RawEvent[];
}

export async function latestRequest(bb: BbPluginApi, threadId: string): Promise<TurnRequest | null> {
  const [event] = await listEvents(bb, { threadId, types: ["client/turn/requested"], order: "desc", limit: 1 });
  return event === undefined ? null : parseRequest(event);
}

export async function requestsAfter(bb: BbPluginApi, threadId: string, afterSeq: number): Promise<TurnRequest[]> {
  return (await listEvents(bb, { threadId, types: ["client/turn/requested"], afterSeq, order: "asc", limit: 100 })).map(parseRequest);
}

/** Items that are the model's own output, not a tool it runs. */
const MODEL_ITEM_TYPES = new Set(["agentMessage", "reasoning", "userMessage"]);

function itemOf(event: RawEvent): { id: string; type: string } {
  const item = ((event.data ?? {}) as { item?: { id?: unknown; type?: unknown } }).item ?? {};
  return { id: str(item.id) ?? "", type: str(item.type) ?? "unknown" };
}

/** Types of tool items (commands, tool calls, subagents, compaction…) started after `afterSeq` and not completed. */
export async function openToolItems(bb: BbPluginApi, threadId: string, afterSeq: number): Promise<string[]> {
  const started = await listEvents(bb, { threadId, types: ["item/started"], afterSeq, order: "desc", limit: 50 });
  if (started.length === 0) return [];
  const completed = await listEvents(bb, { threadId, types: ["item/completed"], afterSeq, order: "desc", limit: 200 });
  const done = new Set(completed.map((event) => itemOf(event).id));
  return started
    .map(itemOf)
    .filter((item) => !MODEL_ITEM_TYPES.has(item.type) && !done.has(item.id))
    .map((item) => item.type);
}

/** How many tool items (commands, tool calls, subagents…) the turn after `afterSeq` ran; capped at 200. */
export async function countToolItems(bb: BbPluginApi, threadId: string, afterSeq: number): Promise<number> {
  const items = await listEvents(bb, { threadId, types: ["item/started", "item/completed"], afterSeq, order: "desc", limit: 200 });
  return new Set(items.map(itemOf).filter((item) => !MODEL_ITEM_TYPES.has(item.type)).map((item) => item.id)).size;
}

/** Child threads still running: a parent that ends its turn while they work is waiting, not stuck. */
export async function runningChildren(bb: BbPluginApi, threadId: string): Promise<number> {
  const rows = (await bb.sdk.threads.list({ parentThreadId: threadId, archived: false, includeHidden: true, limit: 200 })) as unknown as Array<{ status: string }>;
  return rows.filter((row) => row.status === "active" || row.status === "starting").length;
}

interface ListRow {
  id: string;
  activity?: { activeBackgroundAgentCount?: number; activeBackgroundCommandCount?: number; activeWorkflowCount?: number };
}

/**
 * Open background work on the thread (Claude background agents, commands,
 * workflows). A turn waiting on it is not stalled, and stopping the thread
 * would kill that work, so every automatic action here leaves such a thread alone.
 */
export async function openBackgroundWork(bb: BbPluginApi, threadId: string): Promise<number> {
  for (let offset = 0; ; offset += 200) {
    const page = (await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200, offset })) as unknown as ListRow[];
    const row = page.find((thread) => thread.id === threadId);
    if (row !== undefined) {
      const activity = row.activity ?? {};
      return (activity.activeBackgroundAgentCount ?? 0) + (activity.activeBackgroundCommandCount ?? 0) + (activity.activeWorkflowCount ?? 0);
    }
    if (page.length < 200) return 0;
  }
}

export async function hasPendingInteraction(bb: BbPluginApi, threadId: string): Promise<boolean> {
  return (await bb.sdk.threads.interactions.list({ threadId })).length > 0;
}

const PERMISSION_MODES = new Set(["accept-edits", "auto", "full", "workspace-write"]);

/**
 * Sends one agent-only message, replaying the execution of the turn it
 * continues. It is an ordinary dispatch: it queues behind a busy thread
 * (never steers) and passes the `message.dispatch` hooks like any message.
 */
export async function sendAgentOnly(
  bb: BbPluginApi,
  args: { threadId: string; text: string; execution: Execution | null },
): Promise<void> {
  const execution = args.execution ?? {};
  const send = bb.sdk.threads.send as unknown as (input: Record<string, unknown>) => Promise<unknown>;
  await send({
    threadId: args.threadId,
    input: [{ type: "text", text: args.text, mentions: [], visibility: "agent-only" }],
    mode: "queue-if-active",
    ...(execution.model === undefined ? {} : { model: execution.model }),
    ...(execution.reasoningLevel === undefined ? {} : { reasoningLevel: execution.reasoningLevel }),
    ...(execution.serviceTier === undefined ? {} : { serviceTier: execution.serviceTier }),
    ...(execution.permissionMode === undefined || !PERMISSION_MODES.has(execution.permissionMode)
      ? {}
      : { permissionMode: execution.permissionMode }),
  });
}
