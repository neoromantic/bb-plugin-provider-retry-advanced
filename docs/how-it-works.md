# How connectivity recovery works

1. When the plugin loads, and then 60 seconds after each scan ends, it lists threads in
   `error`. With none, it stops there and sends nothing over the network.
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
   count. A turn interrupted by `host-connection-lost` counts too.
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

These are separate checks, not one transaction. A hold or stop that arrives
after the hook let an attempt through does not undo it: that turn runs, and
you stop it like any other. A user's explicit Send-now on a queued row skips
the hook, as BB designs it. Nothing is stored except the explain
diagnostics and holds; the failed turn itself is the source of truth, so a
restart or reinstall picks up where it was.

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


## Compatibility

- BB 0.46.1 or later, plugin SDK 0.6.49. Runs on the BB server.
- Uses public plugin SDK calls only: `threads.list`, `threads.count`,
  `threads.get`, `threads.events.list`, `threads.interactions.list`,
  `threads.queue.list`, `threads.queuedMessages.delete/send`,
  `threads.retry`, `bb.background.service`, `bb.events.on`, `bb.cli`,
  `bb.storage.kv`.
- The probe runs from the BB server. With a remote machine the provider call
  may leave from that machine, so a server-side probe is an approximation
  there; a turn that fails again is resumed again at the next scan.


## Development and tests

```sh
bun install
bun run check   # TypeScript 7, as upstream
bun test        # bun:test, includes the upstream tests ported from vitest
bun run bundle   # bb plugin build .
```

`test/fake-core.ts` reimplements the parts of BB core's retry path the plugin
relies on (from `turn-retry.ts`, `turn-failed.ts` and the `message.dispatch`
pass of bb 0.46.1), so the tests check behavior against core's rules rather
than against the plugin. It is not core: it has no admission lock, no claimed
rows and no provider, so it cannot prove concurrency guarantees.
`test/review-cases.test.ts` keeps the independent review's failing cases.

