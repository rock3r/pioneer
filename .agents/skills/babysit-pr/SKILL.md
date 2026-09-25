---
name: babysit-pr
description: Monitor a Pioneer pull request until checks, automated reviews, and mergeability reach a terminal state.
---

# PR Babysitter

Use `scripts/gh_pr_watch.py` to monitor a pull request created from this repository.

The watcher falls back to GitHub GraphQL when the REST review-list endpoint
fails. It still fails closed when neither source can provide review state.

`request_codex_review` means the current head needs `@codex review`; `diagnose_codex_review` means review state could not be verified. Both return control to the caller. Only an actively running review emits the passive `wait_codex` action.

```bash
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --once
```

The script emits JSON with an `actions` list. Where the list sits depends on the mode:

| Mode | Where to read `actions` |
| --- | --- |
| `--once`, `--snapshot` | Top-level `actions`. |
| `--retry-failed-now` | `snapshot.actions`. The top level reports the rerun: `rerun_attempted`, `rerun_count`, and `reason`. |
| `--watch` | `payload.snapshot.actions` on `snapshot` events, and `payload.actions` on `stop` events. |

Do not merge until it reports `stop_ready_to_merge`: required CI must pass, the Codex review bot must have completed a review of the current head commit, and all actionable review items must be addressed. Missing, stale, running, or unavailable Codex review state blocks merging. Request `@codex review` if the current head has not been reviewed. Bugbot has been dismissed and is not a merge gate; do not request or wait for it. Use `--watch` only when the caller can stream long-running command output; otherwise rerun `--once` after completing required fixes.

`blocking_review_items` lists inline review comments whose threads are still open, including threads started by the authenticated account. While it is not empty, the watcher never emits `stop_ready_to_merge`. If the unresolved-thread lookup fails, every actionable inline comment blocks until the lookup works again.

## Merge conflicts

`diagnose_merge_conflict` means the PR is `CONFLICTING` or `DIRTY`. Merge `origin/main` into the PR branch, resolve the conflicts, and run `npm run check`. A merge keeps the branch history, so a normal push is enough. Rebase only when the owner asks for it, because a rebase rewrites history and needs a force push. Push only as `.agents/skills/git-github-ops/SKILL.md` allows.

## After the PR closes

`stop_pr_closed` also fires when a PR is closed without merging. Before any cleanup, confirm that the PR was merged: check `pr.merged` in the snapshot, or confirm that `gh pr view <number> --json mergedAt` returns a non-empty `mergedAt`. If the PR was closed without merging, keep the worktree and the branch, and tell the owner.

Deleting a branch is destructive, so do it only with the owner's explicit approval. With that approval, run these steps from the main checkout, never from inside the PR worktree:

1. If `git worktree list` shows the PR branch in a linked worktree, run `git worktree remove <path>`. Do not force it. If Git refuses because the worktree has changes, ask the owner. Remove the worktree first, because Git does not delete a branch that a worktree uses.
2. Squash merges make the branch look unmerged, so `git branch -d` refuses and `git branch -D` is needed. Force-delete the branch only when its tip is exactly the merged head:

   ```bash
   test "$(git rev-parse <branch>)" = "$(gh pr view <number> --json headRefOid --jq .headRefOid)" && git branch -D <branch>
   ```

   If the tips differ, the branch has commits that were not merged. Keep it and tell the owner.
