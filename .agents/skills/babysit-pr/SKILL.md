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

The script emits JSON with an `actions` list. Do not merge until it reports `stop_ready_to_merge`: required CI must pass, the Codex review bot must have completed a review of the current head commit, and all actionable review items must be addressed. Missing, stale, running, or unavailable Codex review state blocks merging. Request `@codex review` if the current head has not been reviewed. Bugbot has been dismissed and is not a merge gate; do not request or wait for it. Use `--watch` only when the caller can stream long-running command output; otherwise rerun `--once` after completing required fixes.
