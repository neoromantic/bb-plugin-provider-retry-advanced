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
  Claude background work that outlived the failed turn, including an
  ultracode workflow, keeps running in that session; nothing is relaunched.
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
  blocks overload/limit retries too.

```sh
bb provider-retry-advanced status [thread-id] [--json]   # pending retries + waiting turns
bb provider-retry-advanced explain [thread-id] [--json]  # last decision for a thread
bb provider-retry-advanced retry <thread-id>             # send a pending retry now
bb provider-retry-advanced cancel <thread-id>            # delete it, stop recovering this failure
bb provider-retry-advanced hold <thread-id>              # never auto-resume this thread
bb provider-retry-advanced release <thread-id>           # undo hold and cancel
bb provider-retry-advanced arm                           # once after install
bb provider-retry-advanced scan [--json]                 # run the scan now
bb plugin config provider-retry-advanced set transportRecovery false   # turn recovery off
```

Inspect the failed turn before retrying manually; do not create a second
retry for a turn that already has one queued.
