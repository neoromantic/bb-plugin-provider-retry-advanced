# Changelog

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
