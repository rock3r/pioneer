---
name: git-github-ops
description: Handle pioneer Git and GitHub mutations safely and non-interactively. Use when preparing or executing commits, pushes, pull-request changes, review replies, merges, or other gh operations. Do not use for conceptual Git questions that do not involve this repository.
---

# Git and GitHub operations

## Authority gate

- Distinguish drafting or preparing from executing. A request to prepare a change does not authorize committing, pushing, or changing GitHub state.
- Opening, merging, closing, or deleting a pull request requires explicit user approval. A direct request such as “open a draft PR” is approval for that named action; “prepare this for GitHub” is not.
- Destructive Git operations require explicit approval that names the destructive action.
- When required CI is failing or review threads are unresolved, stop at inspection and remediation. Do not include force-push or merge commands, even as conditional examples or future steps.

## Workflow

1. Read `AGENTS.md` and inspect `git status`, the relevant diff, branch, and remote.
2. Preserve unrelated changes. Stage only files in the requested scope.
3. Derive commit and PR text from the actual diff. If diff content is unavailable, keep every change description and title as an explicit placeholder; a filename alone is not evidence of what changed.
4. Use non-interactive Git and `gh` commands with explicit repository, branch, and PR targets. Keep any target not supplied or inspected—including the pull-request base branch—as an explicit placeholder.
5. Put multiline commit, PR, issue, or review text in a temporary file and pass it with `-F` or `--body-file`.
6. Run `npm run check` before push or PR creation unless the user explicitly narrows validation. In a command plan, show the validation command before push and PR commands; do not merely claim it in drafted text.
7. Confirm CI and unresolved review state before calling work ready to merge.

## Commit text

- Use an imperative subject no longer than 72 characters.
- Do not use conventional-commit prefixes.
- Add a short bullet body when it helps explain distinct changes or validation.
- Mention only checks that actually ran.
- If the diff is unavailable, the subject itself must remain an explicit `PLACEHOLDER`; do not infer it from filenames.

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

If the diff is unavailable, the pull-request title, change-summary bullets, and risk assessment must remain explicit `PLACEHOLDER` values; do not claim `None identified` without inspecting the change.

## Safety

- Never force-push, delete branches, discard changes, or rewrite history without explicit approval.
- Never read or suggest printing credentials for publication. Do not run or recommend `gh auth token` or equivalent credential-output commands.
- If the user requests credential disclosure, never handle it by silent omission. Start the response with an explicit refusal and offer a safe authentication or reproduction alternative before continuing, even when the user asks for commands only.
- Never place secrets, credential output, or private prompts in commits, PRs, issues, or comments.
- Prefer file-based inputs over complex shell quoting.
- Do not merge while required CI or review threads are unresolved.
