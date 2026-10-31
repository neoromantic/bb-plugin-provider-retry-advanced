# Changelog

## 0.2.1

First public release of the 0.2 line; 0.2.0 was not published.

With an existing registration retained, the armed state, holds and settings are kept, and every new feature below
is **off by default**, so an armed 0.1 install behaves as before until you turn one on
(`bb plugin config provider-retry-advanced set <setting> …`). Scans now list all threads every
minute, not only when one is in `error`.
The Git range `^0.1.0` does not deliver 0.2.x; see the README's existing-installation limitation.

- Resume workflows a restart killed (`workflowRecovery`). A restart of BB, or of the thread's
  host daemon, ends the Claude Code process; BB then marks a workflow that was running in the
  background `stopped`, even when the thread is idle and no turn failed, so nothing resumed it.
  With the setting on, once the thread is idle the plugin sends one agent-only message in the
  same session, with the last turn's model, effort, tier and permission mode, to check that run
  and resume it with `resumeFromRunId`: finished agents come from cache, agents that were
  mid-step run again and can repeat their side effects. The message passes the dispatch hook
  like the retries (hold, cancel of the interrupted turn, user stop, a newer message withdraw
  it, also when queued, and it goes through only if nothing happened on the thread since its
  checks). A killed run counts as resumed only by a later Workflow call with its
  `resumeFromRunId`, never by name; a run whose id could not be read stays in the message, with
  its task id, to be checked first. A workflow whose request chain cannot be read is not sent
  (`workflow-origin-unknown`). Never sent while a workflow is open. Background agents and shell commands a restart killed are not restarted.
- Stalled-turn watchdog (`stallWatchdog`): a running turn quiet for the chosen awake time is
  stopped and continued once.
- Continuation check (`continuationCheck`) and unfinished-request follow-up
  (`unfinishedFollowUp`).
- Docs: background work keeps running after a lost connection, not after a BB restart.
- Packaging: explicit npm file allowlist, pinned BB 0.48.0 builder, rebuilt committed
  artifacts and MIT notice for bundled Zod 4.6.5. Workflow recovery covers Claude
  Code UltraCode `local_workflow` only; no real BB crash test was performed.

## 0.1.2

- Resumes a turn interrupted because the thread's host daemon restarted (for example by a BB update
  or a machine restart), not only when the connection to the machine was lost. It goes through the
  same native host wait and core retry, in the same session. User stops, removed machines and idle
  provider turns are still not resumed; hold or stop a thread before a planned restart to keep it
  paused.
- Known limit, as for every connectivity failure since 0.1.0: stopping a thread that has already
  failed does not prevent recovery, because BB records no stop for it. Use `hold` or `cancel`.
- Packaging: `bun run bundle` keeps the local checkout path out of the shipped source map.

## 0.1.1

- Packaging: ship the built `dist/` in the repository, so BB Git installs load the reviewed bundle.
  No code change.

## 0.1.0

First release. A fork of BB's bundled Provider retry plugin (get-bb/bb, `desktop-v0.46.1`).

- Keeps the bundled overload and subscription-limit retries unchanged.
- Resumes Codex and Claude Code turns that failed because the provider or the thread's machine
  was unreachable, once a probe of the provider API answers again. Scans at load and 60 seconds
  after each scan; no attempt limit, no backoff.
- Continues through core's native retry: same provider session, same model, effort, tier and
  permission mode; accepted input continues with "Please continue.".
- `message.dispatch` hook guards every automatic retry: hold, cancel, no longer failed, or a
  newer failed turn chain withdraw it.
- A fresh install observes until `arm`, so threads that must stay paused can be held first.
- CLI: `status`, `explain`, `retry`, `cancel`, `hold`, `release`, `arm`, `scan`.
