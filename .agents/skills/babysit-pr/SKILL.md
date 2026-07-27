---
name: babysit-pr
description: Monitor a Pioneer pull request until checks, automated reviews, and mergeability reach a terminal state.
---

# PR Babysitter

Use `scripts/gh_pr_watch.py` to monitor a pull request created from this repository.

```bash
python3 .agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --once
```

The script emits JSON with an `actions` list. Do not merge until it reports `stop_ready_to_merge`; Bugbot must be `SUCCESS`, and all actionable review items must be addressed. Use `--watch` only when the caller can stream long-running command output; otherwise rerun `--once` after completing required fixes.
