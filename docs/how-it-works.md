# How connectivity recovery works

1. When the plugin loads, and then 60 seconds after each scan ends, it lists threads (the
   ones in `error`, and the ones with a Claude Code workflow open, see below). With no thread
   in `error`, it sends nothing over the network.
2. For each failed Codex or Claude Code thread it reads the latest provider
   turn under the thread's latest request (one request can span several
   provider turns: Claude Code continues by itself when a background task
   reports). If that latest turn did not fail, there is nothing to recover;
   if it failed, the decisive error is the last provider error inside that
   turn (targeted event queries, so in-turn retry noise, earlier turns or
   errors after the turn ended never decide). It counts as a
   connectivity failure when the provider classified it as
   `connection-failed` or `stream-disconnected`, or when an `internal` or
   unclassified error says the path was unreachable (Account Pooler "could not
   reach", `ETIMEDOUT`, `ECONNRESET`, `fetch failed`, "Connection error", ...).
   A provider's own 500, auth, billing, quota and overload errors do not
   count. A turn interrupted because the server lost the thread's machine
   counts too: `host-connection-lost`, or `host-daemon-restarted` (the
   machine came back with a new daemon, for example after a BB update).
3. For the providers those turns need it sends one HEAD request to
   `https://api.anthropic.com/v1/messages` or
   `https://chatgpt.com/backend-api/codex/responses`, without credentials.
   Any answer below 500 means the provider's API edge is reachable from this
   server. That is all it shows: it is not a check of your account, quota or
   Account Pooler health, and it is not a model, token or usage call.
4. If reachable, it re-reads the thread (status, archive, pending approval,
   hold, cancel) and asks core to retry the failed
   turn (`bb.sdk.threads.retry`, the same as `bb thread retry`). Core
   continues accepted input in the same provider session with
   "Please continue.", re-sends input the provider never accepted, and keeps
   the failed turn's model, reasoning effort, service tier and permission
   mode. If the machine is offline, core queues the retry and sends it when
   the machine reconnects.
5. The next scan reads the new state. A turn that fails again for
   connectivity is resumed again; there is no exhausted state.

A failed probe is not a retry.

## When a retry is checked

A retry is checked three times. The scan re-reads the thread before asking
core. Core's retry refuses an archived, deleted or stopping thread, requires
the thread to still be in `error` with that failed turn as its latest, dedupes
retries, and waits behind a pending approval. Then core asks the plugin's
`message.dispatch` hook, under its admission lock, right before the attempt
reaches the provider: inline, and again on every drain of a queued retry
(for example when a machine reconnects). The hook refuses or withdraws this
plugin's own retry when the thread is held, the failure was cancelled, the
thread is no longer in `error` (stopped, answered, recovered), or its current
failed turn chain (read from its events) is not the one the retry was queued
for. Until that chain has been read — right after a load or a new failure —
the retry waits; it never runs on an unknown state.

Stopping a thread that has already failed releases its runtime but leaves it
in `error` with the same failed turn. BB records no stop for it: the most it
leaves is a background task marked `stopped`, which BB also writes for other
interruptions, so it does not mean the user stopped the thread. Such a thread
is still recovered; hold or cancel it instead. A stop while the turn is still
running is recorded as `manual-stop` and is never recovered.

These are separate checks, not one transaction. A hold or stop that arrives
after the hook let an attempt through does not undo it: that turn runs, and
you stop it like any other. A user's explicit Send-now on a queued row skips
the hook, as BB designs it. For connectivity recovery nothing
is stored except the explain diagnostics, holds and cancels; the failed turn
itself is the source of truth, so a restart or reinstall picks up where it
was. Workflows noticed running are stored as described below.

## What is not resumed

- Threads that are stopped, archived or deleted, at discovery and again
  right before the retry is sent.
- Threads waiting for an approval or answer.
- Threads you hold, and a failure whose retry row you cancelled. A hold also
  withdraws the thread's queued retries this plugin created (connectivity,
  overload or limit), and blocks new ones.
- A failure superseded by a later turn on the same thread.
- BB Workflows runs and their hidden workers (BB's Workflows plugin, `bb
  workflows`): the workflow engine retries, replays and retires its own
  workers, and resuming a run is its decision. Only Claude Code's own
  in-session workflows (below) are continued.
- Providers other than Codex and Claude Code (no known probe target).

When a thread this plugin queued a retry for moves on (you stop it or send
something new), the hook blocks that row at its next drain and the plugin
deletes it. It never deletes rows it did not create; it recognises its own by
their reason (`Connectivity restored`, `Provider overloaded`, `Rate limited`).

## Claude Code background work and ultracode workflows (supported)

A Claude Code turn can start background work (a workflow, agents, shell
commands) that keeps running in the Claude process after the foreground turn
failed. Recovery continues the same session, so that work keeps running and
its finished steps stay finished; the plugin starts nothing new and never
re-sends the original task when the provider had accepted it. Steps and
checkpoints Claude already recorded are kept by that continuation. `status`
shows how many background tasks were open.

The model decides what to do next. A tool call that was in flight when the
connection dropped has an unknown outcome: the transcript and tool results
are preserved, but no plugin can guarantee exactly-once side effects for it.

This holds only while the Claude Code process lives, as when the provider
was unreachable. A BB restart or update, or a restart of the machine's host
daemon, ends that process and everything running in it.

## Workflows a restart killed

Off by default; the setting `workflowRecovery` turns it on.

When the server sees the machine's daemon replaced or lost, core closes every
background task that was still open as `stopped`, from the item it last
stored. It does this whether or not a turn was running: a thread whose turn
had ended while its ultracode workflow kept working stays `idle`, with no
failed turn to retry. Claude Code's own close of a task it finished or
stopped (TaskStop, a manual stop of the turn) always carries a presentation;
core's close does not.

1. Every scan notes the threads that have an open Claude Code workflow
   (`activity.activeWorkflowCount`), with the time the scan started, in the
   plugin's storage, so the note survives the restart. A workflow closed
   right after the scan read the list is still found.
2. Once such a thread has no open workflow, the plugin reads every workflow
   closed since then (all pages). A workflow closed by core (`stopped`, no
   presentation) was killed. For each killed task it reads, once, where it
   came from: the result of the Workflow call that started it names the run
   (`Run ID: wf_…`), and the request before its start is the request chain
   it belongs to. A later request does not change that chain.
   A killed run counts as resumed only when a later Workflow call carried its
   `resumeFromRunId`; a workflow's name proves nothing. When the run id could
   not be read, the killed task stays a candidate: the message names it with
   its Claude Code task id and asks to check that task's run and status
   first. When the request chain could not be read (history before the close
   is gone), a cancel could not be honoured, so nothing is sent: the note
   stays and `status` shows `workflow-origin-unknown`. With nothing killed
   and unresumed, the note is dropped.
3. It drops the note and withdraws a queued message when the thread is held,
   a BB Workflows worker, archived or deleted, when the user stopped it
   (`manual-stop`), when the failed turn chain the workflows ran under was
   cancelled (`cancel`, or deleting its retry row; only the workflows that
   chain started), or when a person or
   another thread wrote to it after the kill. A later, independent workflow
   on the same thread is not affected by an old cancel. It waits while the
   thread is not idle (a failed turn is retried first, as above), for an
   approval, for `arm`, while background work is open again (the agent may
   have resumed it) and while another message is queued.
4. Then it sends one agent-only message in the same session, with the last
   turn's model, effort, tier and permission mode: check the run and what its
   interrupted steps already did, then resume it with the Workflow tool and
   `resumeFromRunId`; if the run is gone, say so instead of starting a new
   one. The note is removed only when a later scan sees that message on the
   thread, so a send that fails is tried again and one that did go out is not.
5. The message passes the `message.dispatch` hook like the retries. The
   checks above end with the thread's latest event sequence; the hook lets
   the message through once, to an idle thread, not held, not cancelled, and
   only if the thread has no event after that sequence (one indexed read; a
   turn, a request, a stop or a workflow starting all add events). Otherwise
   an inline send is refused and the next scan checks again. A queued message
   waits at every drain until the checks run again on the current state, then
   goes through the same test; a hold or a cancel withdraws it at once, and
   deleting it on the queue card drops the note.

This covers Claude Code UltraCode `local_workflow` tasks only. Claude Code
can reuse a run's journal when asked to resume by id: completed agents may
return cached results and interrupted agents may run again. The agent may
decide otherwise, the journal may be gone, and re-run agents repeat their
side effects. Evidence is synthetic fixtures and a historical incident;
no real BB crash test was performed. This is a request to resume, not a
guarantee.

Not covered: background agents and shell commands the restart killed, a
workflow that started less than a scan before the restart or while the
plugin was off, and a workflow BB still shows as running after its process
died (no evidence that it is dead, so nothing is sent).


## Compatibility

- BB 0.46.1 or later, plugin SDK 0.6.49. Runs on the BB server.
- Uses public plugin SDK calls only: `threads.list`, `threads.send`,
  `threads.get`, `threads.events.list`, `threads.interactions.list`,
  `threads.queue.list`, `threads.queuedMessages.delete/send`,
  `threads.retry`, `bb.background.service`, `bb.events.on`, `bb.cli`,
  `bb.storage.kv`.
- The probe runs from the BB server. With a remote machine the provider call
  may leave from that machine, so a server-side probe is an approximation
  there; a turn that fails again is resumed again at the next scan.


## Development and tests

```sh
bun install --frozen-lockfile
bun run check   # TypeScript 7, as upstream
bun test        # bun:test, includes the upstream tests ported from vitest
bun run bundle   # official bb-app 0.48.0; build SDK 0.6.94
```

The package checks against SDK 0.6.49; the build uses BB 0.48.0's pinned
esbuild 0.28.1 and emits SDK 0.6.94 metadata. The declared BB minimum remains
0.46.1; build metadata alone does not prove that minimum's managed install.

`test/fake-core.ts` reimplements the parts of BB core's retry path the plugin
relies on (from `turn-retry.ts`, `turn-failed.ts` and the `message.dispatch`
pass of bb 0.46.1), so the tests check behavior against core's rules rather
than against the plugin. It is not core: it has no admission lock, no claimed
rows and no provider, so it cannot prove concurrency guarantees.
`test/review-cases.test.ts` keeps the independent review's failing cases.

