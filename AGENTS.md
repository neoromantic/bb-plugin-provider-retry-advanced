# bb-plugin-provider-retry-advanced

<!-- devkit:agents v1 -->
<!-- managed by devkit v1: edit in https://github.com/neoromantic/devkit/blob/main/agents/AGENTS.shared.md -->
## Shared rules (devkit)

These rules apply to people and coding agents in every repo that uses
[devkit](https://github.com/neoromantic/devkit). Project rules follow in `## Project` below.
Where they conflict, the project section wins.

### Data

- Use only made-up data in tests, fixtures, examples, docs and screenshots. No real people, chats,
  phone numbers, tokens, session files or local paths such as home directories.
- Never commit `.env` files or credentials. Tests run offline by default; live API tests are
  opt-in and read their credentials from the environment.

### Commands

Use the project section's native commands for checks, offline tests and builds:

- Bun: `bun run <script>` (`check`, or `lint` and `typecheck`; `test`, `test:e2e`, `build`).
- Python: the documented `uv run` / `uvx` commands, such as pytest, unittest and ruff.
- Go: the documented `go` commands from `go.mod`. Do not add Bun wrappers for Python or Go.
- Use Bun, uv or Go modules for installs. Use npm only for `npm publish` and `npm view`.

### Definition of done

- The change works end to end and the project's applicable checks and tests pass locally.
- README, docs and affected demos change with the behaviour they describe; follow the
  [product content standard](https://github.com/neoromantic/devkit/blob/main/docs/standards/product-content.md).
- No new warnings, no commented-out code, no stray debug output.

### Commits and releases

- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`.
  A breaking change adds `!` (`feat!:`) and a `BREAKING CHANGE:` footer.
- One logical change per commit. Never rewrite published history or force-push `main`.
- Follow the project's documented release procedure, including any owner-only steps. It defines
  versioning, tags, changelog and delivery (release, skill revision or production deployment).

### Files

- Don't add planning or progress files (`progress.md`, `docs/plans/`). Plans live in issues.
  `ROADMAP.md`, if present, is a short "Known gaps" list that links issues.
- Don't add agent hooks that rewrite tracked files.
- `AGENTS.md` is the canonical instruction file. `CLAUDE.md` contains only `@AGENTS.md`.
- Files marked "managed by devkit" (this block, `SECURITY.md`, `CONTRIBUTING.md`, the PR
  template, `.gitleaks.toml`, `.github/zizmor.yml`, `renovate.json`, `lefthook.yml` and the
  CI stub) are synced from devkit. Change them there, not here.
<!-- /devkit:agents -->

## Project

A server-side BB plugin (TypeScript, Bun for tooling). BB loads `server.ts` through the built
`dist/server.js`; `dist/` is committed because BB's Git installs need the built artifact.

- Install: `bun install --frozen-lockfile`
- Check: `bun run check` (TypeScript 7, as upstream BB)
- Test: `bun test` (offline; `test/fake-core.ts` restates BB core's retry and dispatch-hook rules)
- Build: `bun run bundle` (official `bb-app@0.48.0` CLI; then replaces the
  checkout's absolute path in the source map). Commit `dist/` with every source change; CI does
  not run BB.
- `src/retry-policy.ts`, `src/retry-contract.ts`, `src/queued-retries.ts` and `src/diagnostics.ts`
  are unchanged from upstream BB. Keep them so; record any change in `NOTICE`.
- Never retry, send to or stop real threads from tests. Tests use the fake core only.

### Release

1. Bump `version` in `package.json`, update `CHANGELOG.md` and README in the same PR.
2. `bun run check && bun test && bun run bundle`; commit the rebuilt `dist/`.
3. After green `ci` on `main`: tag `vX.Y.Z` and publish a GitHub Release with the changelog entry.
   BB resolves `git:…@semver:^X.Y.Z` from these tags.
