# Changelog

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
