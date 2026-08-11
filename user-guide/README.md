# Pioneer user guide

Pioneer lets coding agents delegate tasks to the Pi coding agent installed on your machine. Today those tasks are independent code reviews and isolated skill-eval runs. Pi uses the providers and models you already configured; Pioneer supplies readiness checks, an isolated Pi home, native sandboxing on macOS and Linux, and a shared agent skill.

## Start here

1. [Getting started](getting-started.md) — install Pi and Pioneer, configure a provider, and run the first review
2. [Reviewing code](reviewing-code.md) — prompts, common review scopes, reference directories, and reports
3. [Models and thinking](models-and-thinking.md) — select configured models and thinking levels without ambiguity
4. [Sandbox and path grants](sandbox-and-paths.md) — understand read-only source access, scratch, networking, and Windows
5. [Agent integrations](plugins.md) — install Pioneer for Codex, Claude Code, or another coding agent
6. [Skill evals](skill-evals.md) — prepare and run isolated baseline/with-skill actors
7. [Troubleshooting](troubleshooting.md) — diagnose readiness, model, sandbox, proxy, and plugin failures

For implementation details and the threat model, see the [technical documentation](../docs/README.md).

## What Pioneer does

- detects Pi and configured models before creating review state;
- rejects missing or ambiguous requested models with the configured model list;
- supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` thinking;
- copies your Pi agent directory into a private writable run area;
- gives Pi read-only access to source/reference directories and a private writable scratch directory;
- mediates networking through an authenticated proxy;
- writes a private real-time work log with five-second liveness heartbeats;
- returns Pi's review as Markdown.

Pioneer does not choose what “the changes” means. Describe the target in your prompt so Pi knows whether to inspect the working tree, staged changes, a commit, a branch comparison, or a specific subsystem.
