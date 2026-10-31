---
name: provider-retry-advanced
description: "Diagnose automatic retries of BB turns after provider overloads, subscription-window limits and lost connectivity (Provider retry advanced plugin)."
---

# Provider retry advanced

A fork of the bundled Provider retry plugin. Enable one of the two, not both.

It keeps the bundled behavior for two failures, unchanged: a provider
overload (short delay that doubles, at most four retries) and a
subscription-window limit (retried shortly after the reported reset; the
`maximumWait` setting caps how far away that may be).

It adds connectivity recovery. A Codex or Claude Code turn that failed because
the provider could not be reached (connection failed, stream disconnected,
Account Pooler "could not reach", socket timeouts and resets) or because the
server lost the thread's machine (connection lost, or its host daemon
restarted) is resumed once the path answers again:

- A scan runs when the plugin loads and then 60 seconds after each scan ends. It reads the
  current failed threads, so failures from before installation are included.
- Before a retry it sends one unauthenticated HEAD to the provider's API
  (`api.anthropic.com` or `chatgpt.com`). An answer below 500 only shows the
  API edge is reachable, not account, quota or Account Pooler health. No
  token, model or usage call. With nothing waiting it makes no network request.
- A fresh install only observes until `bb provider-retry-advanced arm`, so
  threads that must stay paused can be held first.
- There is no attempt limit and no backoff: a turn that fails again for
  connectivity is resumed again at the next scan once reachable.
- The retry is core's own (`bb thread retry`): accepted input continues the
  same provider session with "Please continue.", unaccepted input is re-sent,
  and the failed turn's model, effort, tier and permission mode are kept.
  After a lost connection, Claude background work that outlived the failed
  turn, including an ultracode workflow, keeps running in that session.
- A BB restart (or the machine's host daemon restarting) is different: it
  kills the Claude Code process and all its background work. BB marks a
  running workflow `stopped`, even on an idle thread. With the setting
  `workflowRecovery` on (off by default), once the thread is idle the plugin
  sends one agent-only "[bb provider-retry-advanced: interrupted workflow]"
  message in the same session to check and resume that run with
  `resumeFromRunId`: finished agents come from cache, agents that were
  mid-step run again. Only workflows a scan saw running; never one BB still
  shows as running; not background agents or shell commands; withdrawn at
  dispatch on hold, cancel of the interrupted turn, user stop, BB Workflows
  workers, or when someone wrote to the thread after the kill.
- A lost machine is queued natively and dispatches when it reconnects.
- Not resumed: other failures (auth, billing, quota, a provider's own 5xx,
  overloads), stopped, archived or deleted threads, threads waiting for an
  approval, BB Workflows runs and workers (the workflow engine owns them),
  held threads, a failure whose retry row was cancelled, and a failure a later
  turn superseded. Core enforces archive/delete/stopping/failed-turn/dedupe in
  the retry; the plugin's `message.dispatch` hook refuses or withdraws its own
  retries at dispatch and on every queued drain (hold, cancel, no longer in
  error, current failed chain differs; unknown chain → wait). Before `arm`
  such rows wait untouched. An attempt the hook already let through is not undone.
- A hold also withdraws the thread's queued retries from this plugin and
  blocks overload/limit retries, stall restarts and follow-ups too.

Stalled turns and follow-ups (each off by default; on only if the operator set it):

- Watchdog: a running turn with no new events for the chosen awake time
  (setting `stallWatchdog`: Off/15/20/30/60 minutes) is stopped and continued
  once with an agent-only "[bb provider-retry-advanced: stalled turn]"
  message. Skipped: pending approval/question, a tool call still running,
  background work open, held, BB Workflows workers, already restarted once,
  before `arm`. Sleep of the Mac does not count.
- Continuation check (`continuationCheck`): after an automatic retry or
  restart, a turn that ends on a short "Продолжу…"/"I'll continue" after at
  most five tool calls gets one "[bb provider-retry-advanced: continue]"
  message, unless it waits for you, background work or running child threads.
- Unfinished request (`unfinishedFollowUp`): a person's message or an
  automation run that failed for connectivity/overload/rate limit and was then
  superseded by system notifications (so core never retried it) is sent back
  once, as "[bb provider-retry-advanced: unfinished request]", when the thread
  is idle and nobody wrote since.
- A message starting with "[bb provider-retry-advanced" came from this
  plugin, not from the user: continue the task, check the state of anything
  you started first, and resume an interrupted BB workflow with
  `bb workflows run … --resume <run-id>`. For "interrupted workflow", first
  check the run's status and what its interrupted steps already did, then
  call the Workflow tool with `resumeFromRunId` set to the run id from the
  result of the Workflow call that started it. If the run or its journal is
  gone, say so; do not start the workflow again on your own.
- Failed BB Workflows runs are not resumed by the plugin (no API to start or
  resume a run from a plugin); the starting thread resumes them.

```sh
bb provider-retry-advanced status [thread-id] [--json]   # pending retries + waiting turns
bb provider-retry-advanced explain [thread-id] [--json]  # last decision for a thread
bb provider-retry-advanced retry <thread-id>             # send a pending retry now
bb provider-retry-advanced cancel <thread-id>            # delete it, stop recovering this failure
bb provider-retry-advanced hold <thread-id>              # never auto-resume this thread
bb provider-retry-advanced release <thread-id>           # undo hold and cancel
bb provider-retry-advanced arm                           # once after install
bb provider-retry-advanced scan [--json]                 # run the scan now
bb provider-retry-advanced watchdog [--json]             # run the stalled-turn check now
bb plugin config provider-retry-advanced set transportRecovery false   # turn recovery off
```

Inspect the failed turn before retrying manually; do not create a second
retry for a turn that already has one queued.
