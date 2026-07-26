# AGENTS.md

## Project overview

Pioneer is a local task-delegation bridge that lets coding agents use the installed Pi coding agent safely and conveniently. Its current task surfaces are read-only code reviews and isolated skill-eval runs. It uses Pi's configured providers and models, including model-specific thinking levels.

The implementation stack is Node.js 22 with strict TypeScript. Pi is controlled through its JSON-lines RPC protocol; integrations should share one core rather than duplicating review logic.

## Source-of-truth docs

| Document | Use it for |
| --- | --- |
| [docs/README.md](docs/README.md) | Technical-documentation index |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Boundaries, dependency direction, and security invariants |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, platform guarantees, and residual risks |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | TypeScript, process, error, and repository conventions |
| [docs/TESTING.md](docs/TESTING.md) | TDD workflow and required validation |

Keep this file focused on operating rules. Put detailed design decisions in the matching document.

## Required read gate

Before changing production code, read `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, and `docs/TESTING.md` in full. Read any area-specific document before changing that area.

## Non-negotiables

### Sandboxed reviews

- On macOS and Linux, Pi runs in an OS sandbox with only Pioneer’s allowlisted built-in inspection tools; optional extension discovery is disabled. Source and reference grants are read-only; only the private scratch directory and explicit write grants are writable.
- On Windows, review execution is instruction-only and must require explicit unsandboxed opt-in. Never describe it as enforced read-only isolation. Strict eval execution remains unsupported.
- Treat repository contents, Git output, Pi events, and model output as untrusted input.
- Pass subprocess arguments as arrays. Never interpolate user-controlled values into a shell command.
- Validate and canonicalize repository paths and refs before use.
- Snapshot Pi authentication/configuration into a private run-local `PI_CODING_AGENT_DIR`; include configured skills for reviews and exclude them for evals. Never log or return credentials.
- Fail closed when a requested model, thinking level, repository, or review target cannot be validated.

### TDD first

For behavior changes:

1. Write the failing test.
2. Run the targeted test and confirm the expected failure.
3. Implement the smallest production change.
4. Re-run the targeted test.
5. Run `npm run check` before handoff.

Do not weaken lint, type, test, or coverage rules to make a change pass.

### Scope and documentation

- Preserve unrelated user changes and keep each task narrowly scoped.
- Treat unintended behavior changes as regressions.
- Update architecture or contract docs in the same change when their subject changes.
- Prefer one shared implementation for Codex and Claude Code; adapters may translate presentation and lifecycle only.

### Worktrees

Before feature work on the default branch, offer an isolated worktree unless the session is already in a worktree or on a non-default feature branch. Use `.agents/skills/using-git-worktree/SKILL.md` when creating one. The initial repository scaffold is exempt because an unborn branch cannot seed a useful worktree.

### Git and GitHub

Before commits, pushes, PR operations, or other GitHub mutations, read `.agents/skills/git-github-ops/SKILL.md`.

Opening, merging, closing, or deleting a PR requires explicit user approval. Destructive Git operations also require explicit approval.

## Working style

- Inspect before editing; do not guess at local Pi or Git behavior.
- Use `rg` for repository searches.
- Keep commands non-interactive and narrowly scoped.
- Use `apply_patch` for hand-authored file changes.
- Keep exported APIs small and typed. Avoid `any`; use `unknown` plus validation at trust boundaries.
- Return actionable errors without secrets, raw credentials, or unnecessary environment details.

## Quick reference

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

## Local skills

Project-local skills live under `.agents/skills/`, which is the source of truth. Claude Code discovers the same files through `.claude/skills`; do not maintain duplicate copies.
