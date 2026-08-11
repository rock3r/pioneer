# Changelog

All notable user-facing changes are recorded here. The project follows semantic versioning.

## Unreleased

- Add controller-owned, real-time review work logs with platform-standard default storage, `--work-log` custom targets, immediate path discovery, five-second hang-detection heartbeats, sanitized Pi RPC diagnostics, bounded private files, and automatic default-log retention.
- Add an Agent Plugins v1 portable manifest so compatible coding agents can discover Pioneer's existing Agent Skill without a Codex- or Claude-specific package layout.

## 0.1.6 - 2026-08-10

- Refresh the tested Pi compatibility maximum to `0.84.1`, including the release matrix and a regression test for Pi's delta-only RPC updates.
- Require Node.js 22.19.0 for Pi 0.84.1 and align the user-facing compatibility references.
- Fail closed on Pi assistant errors, preserve split UTF-8 RPC output, and bound cumulative RPC output at 4 MiB.

## 0.1.5 - 2026-07-30

- Add a throttled background npm update notice plus `pioneer check-update` and npm-delegated `pioneer update` commands with interactive or scripted changelog/install choices.
- Ensure reviews do not complete until Pi's process and RPC pipes close, with bounded cleanup when descendants retain those pipes.
- Reject Git-target review scopes on macOS and Windows, where source-only tools cannot inspect them.
- Refresh the tested Pi compatibility maximum to `0.83.0`.

## 0.1.4 - 2026-07-26

- Add controller-owned atomic review report output with `pioneer review --report FILE`, including persistence-failure handling and packaged validation of review completion failures.

## 0.1.3 - 2026-07-26

- Refresh the tested Pi compatibility maximum to `0.82.1`.
- Correct Pi compatibility and isolation guidance across the release and user documentation.
- Make `pioneer doctor` the shared review/eval readiness command.
- Unify eval preparation, execution, and Linux setup under `pioneer eval` and remove the separate `pioneer-eval` binary.
- Disable optional Pi extension discovery for review and eval actors and restrict reviews to an allowlist of Pi's built-in inspection tools.
- Fail review transport with stable diagnostics when Pi settles without a report or exits before settling, and document stdout persistence and caller-side watcher boundaries.

## 0.1.2 - 2026-07-24

- Add `pioneer --version` and `pioneer-eval --version`.
- Enforce Pi `0.80.6` as the minimum supported version and warn above the release's tested maximum.
- Test both Pi compatibility endpoints in CI and block releases when the tested maximum is behind npm `latest`.
- Exclude root temporary Pi-home trees and raise the bounded entry budget to 500,000 while retaining extension package dependencies.

## 0.1.1 - 2026-07-23

- Make both CLI `--help` paths succeed without writing usage to stderr.
- Add `pioneer models` with human-readable and schema-versioned JSON output.
- Reject partial model catalogs when Pi reports an invalid `models.json`.
- Support managed Pi installations whose agent-bin Pi launcher is an external symlink without weakening the general escaping-link rejection.
- Replace the standalone README mascot with an optimized Pioneer banner.

## 0.1.0 - 2026-07-23

- Launch as Pioneer, with the `@rock3r/pioneer`, `pioneer`, and `pioneer-eval` distribution identities.
- Add Pi-backed reviews for Codex and Claude Code with explicit model and thinking-level selection through `max`.
- Add early Pi, configuration, and model-readiness diagnostics with stable error IDs and JSON doctor output.
- Enforce read-only review sources plus writable scratch space on macOS and Linux, with configurable extra path grants and networking.
- Add isolated skill-eval runs with public-only egress on macOS and Linux.
- Document Windows as explicit instruction-only review mode; eval runs fail closed while the AppContainer launcher remains experimental.
- Add public package/plugin metadata, cross-platform CI, packed-artifact smoke tests, and gated npm/GitHub release automation.
