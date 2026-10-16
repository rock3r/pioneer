# Pioneer user guide

Pioneer lets coding agents run independent code reviews and isolated skill evaluations through your installed Pi coding agent. Pi uses your configured providers and models. Pioneer checks readiness, copies Pi configuration, and applies native sandboxing on macOS and Linux. Agents use one shared skill to call Pioneer.

## Start here

1. [Getting started](getting-started.md) explains installation, provider setup, and the first review.
2. [Reviewing code](reviewing-code.md) covers prompts, review scopes, reference directories, and reports.
3. [Models and thinking](models-and-thinking.md) explains model names and thinking levels.
4. [Sandbox and path grants](sandbox-and-paths.md) covers filesystem access, scratch, networking, and Windows limits.
5. [Agent integrations](plugins.md) explains installation for Codex, Claude Code, and other coding agents.
6. [Skill evals](skill-evals.md) explains how to prepare and run baseline and with-skill actors.
7. [Troubleshooting](troubleshooting.md) covers readiness, model, sandbox, proxy, and plugin failures.

For implementation details and the threat model, see the [technical documentation](../docs/README.md).

## What Pioneer does

- Pioneer checks Pi and configured models before launching the review actor.
- It rejects missing or ambiguous requested models and prints the configured model list.
- It supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` thinking.
- It copies selected Pi configuration and review skills into a private writable run area.
- On macOS and Linux, it gives Pi read-only source/reference access and private writable scratch.
- It routes networking through an authenticated proxy.
- It writes a private real-time work log with five-second liveness heartbeats.
- It returns Pi's review as Markdown.

Name the review target in your prompt. Choose the working tree, staged changes, a commit, a branch comparison, or a specific subsystem.
