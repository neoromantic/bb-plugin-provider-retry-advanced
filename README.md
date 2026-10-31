# bb-plugin-provider-retry-advanced

BB plugin: provider retry plus automatic resume after lost connectivity.

![Synthetic illustration of provider-retry-advanced connectivity status](docs/images/hero.svg)

[![ci](https://github.com/neoromantic/bb-plugin-provider-retry-advanced/actions/workflows/ci.yml/badge.svg)](https://github.com/neoromantic/bb-plugin-provider-retry-advanced/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/neoromantic/bb-plugin-provider-retry-advanced)](https://github.com/neoromantic/bb-plugin-provider-retry-advanced/releases)
[![license](https://img.shields.io/github/license/neoromantic/bb-plugin-provider-retry-advanced)](LICENSE)

An unofficial fork of the **Provider retry** plugin bundled with [BB](https://github.com/get-bb/bb).
It does everything that plugin does, and it also resumes Codex and Claude Code turns that failed
because the provider or the thread's machine could not be reached, once it can be reached again.
Optional, off by default: it can ask Claude Code to resume an ultracode workflow a BB restart
killed, restart turns that stalled, nudge a resumed turn that stopped at "I'll continue", and
send back a failed request that later notifications pushed aside.

## Install

Needs BB 0.46.1 or later. Run one retry plugin, not both, so disable the bundled one first:

```sh
bb plugin disable provider-retry
bb plugin install git:https://github.com/neoromantic/bb-plugin-provider-retry-advanced.git@semver:^0.2.1 --yes
```

Or install the exact npm version:

```sh
bb plugin install npm:bb-plugin-provider-retry-advanced@0.2.1 --yes
```

### Existing installations

A Git source tracking `^0.1.0` stays on 0.1.x. BB 0.48.0 has no native command
to replace a managed plugin's saved source or range: `update` uses the saved
range, and another `install` is refused. Keep the current installation and
configuration until a state-preserving source change is supported. Removing
the plugin deletes its settings and holds. Local path installations can keep
their existing path; changing source kind is not required for a path update.

## Quickstart

A fresh install only observes: BB starts a plugin enabled and its first scan runs at load, so
nothing is retried until you `arm` it. Hold any thread that must stay paused first.

```sh
bb provider-retry-advanced status                # what it would resume
bb provider-retry-advanced hold <thread-id>      # optional: never auto-resume this thread
bb provider-retry-advanced arm                   # start; needed once, kept across reloads and restarts
```

From then on it checks when it loads and 60 seconds after each scan.

## Features

- Resumes turns that failed for lost connectivity: `connection-failed`, `stream-disconnected`,
  Account Pooler "could not reach", socket timeouts and resets, a lost connection to the
  thread's machine, or a restart of its host daemon. A provider's own 5xx, auth, billing, quota
  and overload errors do not count.
- Probes before it retries: one unauthenticated HEAD to the provider's API. An answer below 500
  only shows the API edge is reachable, not that your account or Account Pooler is healthy. No
  token, model or usage call; with nothing waiting it sends nothing.
- No attempt limit and no backoff for connectivity failures; a fixed 60-second scan.
- Uses core's native retry: same provider session, model, effort, tier and permission mode.
  Accepted input continues with "Please continue."; nothing is re-sent or relaunched.
- After a lost connection, Claude Code background work that outlived the failed turn, such as an
  ultracode workflow, keeps running in that session. A BB restart is different: it ends the
  Claude Code process and everything running in it (next point). BB Workflows runs are left to
  the workflow engine.
- Claude Code UltraCode `local_workflow` recovery (setting `workflowRecovery`, off by default): when BB, or the host
  daemon of the thread's machine, restarts while a Claude Code ultracode workflow runs in the
  background, BB marks the workflow `stopped`, even if the thread is idle and nothing failed.
  Once the thread is idle, the plugin sends one agent-only message in the same session, with the
  last turn's model, effort, tier and permission mode, asking Claude Code to check the run and
  resume it with `resumeFromRunId`. Claude Code keeps the run's journal, so agents that had
  finished return their cached results; agents that were mid-step run again, and their side
  effects (commands, files, messages) can repeat. This asks the agent to resume;
  it cannot guarantee that the run or journal is available. The message
  passes the same dispatch checks as the retries: a hold, a cancel of the interrupted turn, a stop,
  or a newer message withdraws it.
- Guards every automatic retry at dispatch: a hold, a cancel, a stop, or a newer failed turn
  withdraws it. Finds failures from before it was installed.
- Keeps the bundled overload and subscription-limit retries unchanged.
- Stalled-turn watchdog (setting `stallWatchdog`, off by default): a running turn with no new
  events for the chosen time is stopped and continued once with an agent-only message, with the turn's
  model, effort, tier and permission mode. Quiet time counts only while BB is awake, so a
  sleeping Mac never triggers it. It never touches a turn waiting for an approval or a question,
  a turn with a tool call still running, a thread with background work open, a held thread, BB
  Workflows workers, or a turn it already restarted.
- Continuation check: after an automatic retry or restart, a turn that ends on a short
  "Продолжу…" / "Продолжаю…" / "I'll continue" after at most five tool calls gets one more
  continue (setting `continuationCheck`, off by default). Skipped while the thread waits for you, for background work or for
  its running child threads. Once per turn; it never answers its own message.
- Unfinished request follow-up: core retries only a thread's latest turn, so a message or
  automation run that failed (connectivity, overload or rate limit) and was then pushed aside
  by a child-thread notification was never retried. When the thread is idle and nobody wrote
  since, it is sent back once (setting `unfinishedFollowUp`, off by default).
- Automation turns are covered like any other turn: they run in ordinary threads, so both the
  retries and the follow-ups apply.

| | Provider retry (bundled) | Provider retry advanced |
| --- | --- | --- |
| Provider overload | retried, delay doubles, max 4 | same, unchanged |
| Subscription-window limit | retried after the reset, `maximumWait` | same, unchanged |
| Connection failed, stream disconnected, Account Pooler "could not reach", socket timeout/reset | not retried | resumed once the provider answers again |
| Connection to the thread's machine lost, or its host daemon restarted | not retried | queued until the machine reconnects |
| Claude Code workflow killed by a BB or host daemon restart | not resumed | one message to resume the run |
| Failures from before the plugin loaded | no | yes, found by the first scan |
| Attempt limit for connectivity failures | – | none |
| Backoff for connectivity failures | – | none, fixed 60 s scan |


## Usage

```sh
bb provider-retry-advanced status [thread-id] [--json]   # pending retries and turns waiting for connectivity
bb provider-retry-advanced explain [thread-id] [--json]  # last decision for a thread
bb provider-retry-advanced retry <thread-id>             # send a pending retry now
bb provider-retry-advanced cancel <thread-id>            # delete it and stop recovering this failure
bb provider-retry-advanced hold <thread-id>              # never retry this thread automatically
bb provider-retry-advanced release <thread-id>           # undo hold and cancel
bb provider-retry-advanced arm [--json]                  # once after install
bb provider-retry-advanced scan [--json]                 # run the scan now
bb provider-retry-advanced watchdog [--json]             # run the stalled-turn check now
```

`explain` shows reasons such as `waiting-for-connectivity (anthropic: ETIMEDOUT)` or
`Stalled turn restarted`. `status` lists stalled turns and recent follow-ups; every action is also
logged (`bb plugin logs provider-retry-advanced`). A hold also withdraws the thread's queued
retries from this plugin and blocks overload and limit retries, restarts and follow-ups.
Whoever pauses a thread outside BB's own stop is responsible for holding it and releasing it.
A turn cut off by a BB restart or update is resumed too, and with `workflowRecovery` on so is a
Claude Code workflow the restart killed; to keep a thread paused across a planned restart, stop it or hold it first. Stopping a thread that has already failed leaves it in `error`
in BB, so it does not prevent recovery; hold or cancel it instead.

Settings:

```sh
bb plugin config provider-retry-advanced set transportRecovery false  # stop connectivity recovery
bb plugin config provider-retry-advanced set maximumWait "24 hours"   # bundled setting
# Off by default; each turns on separately:
bb plugin config provider-retry-advanced set workflowRecovery true      # resume workflows a restart killed
bb plugin config provider-retry-advanced set stallWatchdog "20 minutes" # Off (default), 15, 20, 30, 60 minutes
bb plugin config provider-retry-advanced set continuationCheck true
bb plugin config provider-retry-advanced set unfinishedFollowUp true
```

Roll back to the bundled plugin:

```sh
bb plugin disable provider-retry-advanced
bb plugin enable provider-retry
bb plugin remove provider-retry-advanced   # also deletes its settings and holds
```

Retries already queued stay in the thread's queue as ordinary rows; cancel them on the queue card
if you no longer want them.

How the checks work, what is not resumed, compatibility and tests:
[docs/how-it-works.md](docs/how-it-works.md).

## Limits

- Recovery is supported by synthetic fixtures and historical incident evidence;
  no real BB crash test was performed. It does not resume native BB Workflows.
- A tool call in flight when the connection dropped has an unknown outcome. The transcript and
  tool results are kept, but no plugin can guarantee exactly-once side effects.
- The checks before a retry are separate steps, not one transaction. A hold or stop that arrives
  after an attempt was let through does not undo it; stop that turn like any other.
- The probe runs from the BB server. For a remote machine it approximates the machine's path.
- Stopping a stalled child thread tells its parent that the child was interrupted (if the
  parent gets notifications); the child is already running again when the parent looks.
- After a restart only Claude Code workflows are resumed. Background agents and shell commands the
  restart killed are not restarted; the agent sees them as stopped. A workflow is noticed only if
  a scan saw it running (it started at least about a minute before the restart, with the plugin
  enabled). A workflow BB still shows as running is never touched, even if its process is gone.
  Whether the run can resume is Claude Code's: agents that were mid-step run that step again, so
  their side effects can repeat.
- Failed BB Workflows runs are not resumed by this plugin: resuming needs the run's script and
  arguments, which only the workflow engine and the thread that started the run hold, and the
  plugin API offers no call to start or resume a run. The engine notifies the starting thread,
  and the plugin's own continue messages tell the agent to resume an interrupted run with
  `bb workflows run … --resume <run-id>`.

## For AI agents

Every command takes `--json`. The bundled skill `provider-retry-advanced` explains the plugin to
agents running in BB. The plugin RPC `decision.get` accepts `{ threadId }` and returns the last
decision, like the bundled plugin.

## Contributing, Security, License

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Checks: `bun run check && bun test`.
- Security: [SECURITY.md](SECURITY.md).
- License: [MIT](LICENSE). Forked from `plugins/provider-retry` of
  [get-bb/bb](https://github.com/get-bb/bb) at tag `desktop-v0.46.1` (MIT, Copyright (c) 2026
  Michael Yong); see [NOTICE](NOTICE).
