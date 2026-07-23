---
name: using-git-worktree
description: Safely create and verify an isolated pioneer Git worktree. Use when the user requests worktree isolation or before feature implementation from the default branch. Do not use for conceptual worktree questions. If isolation was not explicitly requested, offer it and wait before creating anything.
---

# Using Git worktrees

## Authority gate

- If the user explicitly requests a worktree, proceed after preflight.
- If this skill is triggered only because implementation would start on the default branch, offer an isolated worktree and pause. Do not create one until the user accepts.
- A deadline or instruction not to pause never overrides a failed preflight, unrelated local changes, or a known failing baseline. Under deadline pressure, explicitly state: “The deadline does not change the stop condition.”

## Preflight

1. Resolve the repository root with `git rev-parse --show-toplevel`; do not infer it from the process working directory.
2. Check whether `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`. If so, the session is already in a worktree; report it and stop.
3. Check the current branch. If it is a non-default feature branch, report that isolation already exists and stop unless the user explicitly requests another worktree.
4. Confirm the repository has at least one commit. An unborn branch cannot seed a normal feature worktree.
5. Use `.worktrees/<branch-name>` and verify `.worktrees/` is ignored with `git check-ignore` before creation.
6. Inspect `git status --short`. Preserve unrelated changes; do not stash, commit, discard, or move them without explicit authorization.

If any stop condition applies, explain that condition and stop the current response. Do not include a `git worktree add` command as a conditional example or future recipe.

If `.worktrees/` is not ignored, do not create the worktree. Propose the narrow ignore-file change separately; do not fold unrelated edits into it.

## Create

1. Fetch the selected base only when the user has authorized network access.
2. Choose a short hyphenated branch name tied to the task.
3. Confirm the branch and path do not already exist.
4. Create the branch and worktree explicitly from the selected local base:

```bash
git worktree add .worktrees/<branch-name> -b <branch-name> <base-branch>
```

5. Run all subsequent commands with the worktree as the working directory or with explicit absolute paths.
6. Install exact dependencies with `npm ci`.
7. Run `npm run check` to establish a clean baseline before task edits.

If dependency installation or the baseline fails, stop task implementation, report the failure as pre-existing, and ask whether to investigate or proceed. Do not blur it with task changes.

## Report

A worktree-creation response is incomplete until it ends with a handoff report. Return the absolute worktree path, branch, base revision, dependency-install result, and validation result; in a plan-only response, include placeholders for results that have not run.

## Cleanup

Clean up only after the branch is merged or the user explicitly abandons it. Run cleanup from the main checkout, inspect worktree status first, and never force-remove a worktree containing changes without explicit approval.
