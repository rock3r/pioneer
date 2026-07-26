# Changelog

All notable user-facing changes are recorded here. The project follows semantic versioning.

## Unreleased

## 0.1.3 - 2026-07-26

- Refresh the tested Pi compatibility maximum to `0.82.1`.
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
