# Cursor-only notes

These instructions apply to Cursor (including Cursor Cloud agents). Other agents should ignore this file.

## GitHub: use `gh`, not Cursor tools

Always use the GitHub CLI (`gh`) for GitHub operations: issues, pull requests, comments, reviews, CI, labels, and related mutations. Do not use Cursor's GitHub/PR MCP tools (`ManagePullRequest`, `EditPullRequestLabels`, and equivalents). Authenticate via `GH_TOKEN`; do not use the Cursor GitHub App login. Follow `.agents/skills/git-github-ops/SKILL.md` for the actual command shape (non-interactive flags, `--body-file` for multiline text). Never print the token.

## Cursor Cloud VM

Standard commands live in `AGENTS.md` and `docs/TESTING.md`; `npm run check` runs the full gate (lint, typecheck, unit tests, build, e2e). The notes below are VM-specific caveats.

- Node version trap: `.npmrc` sets `engine-strict=true` and `package.json` requires `node >=22.19.0` (`.nvmrc` pins `22.19.0`). The VM's default `node` (`/exec-daemon/node`, v22.14.0) sits ahead of nvm on `PATH`, so a bare `node`/`npm ci` fails with `EBADENGINE`. Interactive shells are fixed via `~/.bashrc`, which prepends the nvm 22.19.0 bin. If a command ever reports `node v22.14.0`, prepend it manually: `export PATH="$NVM_DIR/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin:$PATH"`.
- Native sandbox tests need `bwrap` (Bubblewrap) and `/sbin/apparmor_parser` (apparmor), which are baked into the base snapshot. When absent, sandbox-launching unit/e2e cases and `npm run sandbox:smoke` skip rather than fail; `.github/scripts/install-linux-sandbox-prereqs.sh` documents the exact packages.
- Pi is not installed in this VM. `pioneer review` and `pioneer eval run` require a `pi` CLI on `PATH` (plus provider credentials for real model calls) and fail closed with `[PI_NOT_FOUND]` without one. Everything else works offline: unit tests, e2e (which spawns a scripted Pi stand-in), `npm run sandbox:smoke`, `pioneer doctor`, and `pioneer eval prepare`. To exercise the CLI's Pi-gated paths without credentials, put a scripted `pi` on `PATH` that answers `--version` (in-range SemVer) and `--list-models`, mirroring `test/e2e/support/scripted-pi.ts`.
