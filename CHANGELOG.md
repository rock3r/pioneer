# Changelog

All notable user-facing changes are recorded here. The project follows semantic versioning.

## Unreleased

## 0.1.1 - 2026-07-23

- Make both CLI `--help` paths succeed without writing usage to stderr.
- Add `pioneer models` with human-readable and schema-versioned JSON output.
- Reject partial model catalogs when Pi reports an invalid `models.json`.
- Support Compose Pi installations whose agent-bin Pi launcher is an external symlink without weakening the general escaping-link rejection.
- Replace the standalone README mascot with an optimized Pioneer banner.

## 0.1.0 - 2026-07-23

- Launch as Pioneer, with the `@rock3r/pioneer`, `pioneer`, and `pioneer-eval` distribution identities.
- Add Pi-backed reviews for Codex and Claude Code with explicit model and thinking-level selection through `max`.
- Add early Pi, configuration, and model-readiness diagnostics with stable error IDs and JSON doctor output.
- Enforce read-only review sources plus writable scratch space on macOS and Linux, with configurable extra path grants and networking.
- Add isolated skill-eval runs with public-only egress on macOS and Linux.
- Document Windows as explicit instruction-only review mode; eval runs fail closed while the AppContainer launcher remains experimental.
- Add public package/plugin metadata, cross-platform CI, packed-artifact smoke tests, and gated npm/GitHub release automation.
