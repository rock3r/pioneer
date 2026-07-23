---
name: git-github-ops
description: Handle pioneer Git and GitHub workflows safely and non-interactively. Use for commits, pushes, pull-request creation or updates, review replies, merge preparation, or other gh operations.
---

# Git and GitHub operations

## Workflow

1. Read `AGENTS.md` and inspect `git status`, the relevant diff, branch, and remote.
2. Preserve unrelated changes. Stage only files in the requested scope.
3. Derive commit and PR text from the actual diff; do not invent issue IDs or validation.
4. Use non-interactive Git and `gh` commands with explicit repository, branch, and PR targets.
5. Put multiline commit, PR, issue, or review text in a temporary file and pass it with `-F` or `--body-file`.
6. Run `npm run check` before push or PR creation unless the user explicitly narrows validation.
7. Confirm CI and unresolved review state before calling work ready to merge.

## Commit text

- Use an imperative subject no longer than 72 characters.
- Do not use conventional-commit prefixes.
- Add a short bullet body when it helps explain distinct changes or validation.
- Mention only checks that actually ran.

Example:

```text
Repository setup: add shared agent and CI foundations

- Add strict TypeScript, Biome, and Vitest configuration
- Share project skills with Claude through symlinks
- Run static analysis and tests in separate CI jobs
```

## Pull requests

Use a specific outcome-focused title and this body shape:

```markdown
## Summary
- What changed
- Why it is needed

## Testing
- [x] Exact command that passed

## Risks
- Material risk or `None identified`
```

Opening, merging, closing, or deleting a PR requires explicit user approval under `AGENTS.md`.

## Safety

- Never force-push, delete branches, discard changes, or rewrite history without explicit approval.
- Never place secrets, credential output, or private prompts in commits, PRs, issues, or comments.
- Prefer file-based inputs over complex shell quoting.
- Do not merge while required CI or review threads are unresolved.
