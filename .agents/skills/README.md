# Project-local skills

This directory is the canonical source for agent-facing workflows shared by Codex, Claude Code, and other compatible harnesses. Claude Code reaches the same directory through `.claude/skills`; do not duplicate skill content there.

## Skills

### `git-github-ops`

Use for commits, pushes, pull requests, review replies, merges, or other GitHub operations. It defines diff-grounded text and safe non-interactive command patterns.

### `using-git-worktree`

Use when creating an isolated feature worktree. It verifies ignore rules, installs exact npm dependencies, and checks the clean baseline.
