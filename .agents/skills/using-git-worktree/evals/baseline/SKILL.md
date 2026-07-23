---
name: using-git-worktree
description: Create and verify an isolated pioneer Git worktree. Use before feature implementation on the default branch or whenever the user requests worktree isolation.
---

# Using Git worktrees

## Preflight

1. Check whether `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`. If so, the session is already in a worktree; report it and stop.
2. Check the current branch. If it is a non-default feature branch, report that isolation already exists and stop unless the user explicitly requests another worktree.
3. Confirm the repository has at least one commit. An unborn branch cannot seed a normal feature worktree.
4. Use `.worktrees/<branch-name>` and verify `.worktrees/` is ignored with `git check-ignore` before creation.

## Create

1. Fetch the selected base only when the user has authorized network access.
2. Choose a short hyphenated branch name tied to the task.
3. Create the branch and worktree explicitly:

```bash
git worktree add .worktrees/<branch-name> -b <branch-name> <base-branch>
```

4. Run all subsequent commands with the worktree as the working directory or with explicit absolute paths.
5. Install exact dependencies with `npm ci`.
6. Run `npm run check` to establish a clean baseline.

If the baseline fails, report the failure and ask whether to investigate or proceed. Do not blur pre-existing failures with task changes.

## Report

Return the absolute worktree path, branch, base revision, dependency-install result, and validation result.

## Cleanup

Clean up only after the branch is merged or the user explicitly abandons it. Run cleanup from the main checkout, inspect worktree status first, and never force-remove a worktree containing changes without explicit approval.
