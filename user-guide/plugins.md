# Agent integrations

The portable Agent Plugins package and the Codex and Claude Code adapters load the same `pioneer` skill. It calls the locally installed CLI for review requests and preserves its fail-closed behavior.

Install and configure Pi first. Install the Pioneer CLI, or build and link a trusted checkout. Confirm that the agent's `PATH` contains both commands:

```bash
command -v pi
command -v pioneer
```

No provider authentication is stored in any plugin manifest.

## Agent Plugins v1 clients

[`plugins/pioneer/plugin.json`](../plugins/pioneer/plugin.json) targets the vendor-neutral [Agent Plugins v1 specification](https://agent-plugins.org/specification). A conforming skills-capable client discovers the shared skill at the standard `skills/pioneer/SKILL.md` location without a client-specific manifest.

Each Agent Plugins client defines its own installation and distribution process. Clone or download Pioneer. Load the absolute `plugins/pioneer/` directory through the client's local-plugin installer.

The client still needs `pi` and `pioneer` on its terminal `PATH`. The portable package installs no executables or credentials. The specification's [compatible-client list](https://agent-plugins.org/compatible-clients) links to client setup instructions.

## Claude Code

The repository is a Claude marketplace because [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) catalogs the payload in [`plugins/pioneer`](../plugins/pioneer).

After publication, install from a shell:

```bash
claude plugin marketplace add rock3r/pioneer
claude plugin install pioneer@pioneer
claude plugin list
```

For a local checkout, use its absolute path as the marketplace source:

```bash
claude plugin marketplace add /absolute/path/to/pioneer
claude plugin install pioneer@pioneer
```

The equivalent interactive commands inside Claude Code are:

```text
/plugin marketplace add rock3r/pioneer
/plugin install pioneer@pioneer
/reload-plugins
```

Claude namespaces installed skill commands by plugin. You can invoke `/pioneer:pioneer`, or ask naturally for Pi to review code and let the skill description trigger it.

## Codex

The Codex plugin payload is defined by [`plugins/pioneer/.codex-plugin/plugin.json`](../plugins/pioneer/.codex-plugin/plugin.json), and the repo-local catalog is [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json).

After publication, add the GitHub marketplace and install the plugin:

```bash
codex plugin marketplace add rock3r/pioneer
codex plugin add pioneer@pioneer
codex plugin list
```

For a local checkout, use its absolute path as the marketplace source:

```bash
codex plugin marketplace add /absolute/path/to/pioneer
codex plugin add pioneer@pioneer
codex plugin list
```

Start a new Codex task after installation so the new skill is loaded. The ChatGPT desktop app can also install Pioneer from the configured `pioneer` marketplace in the Plugins Directory.

Ask naturally, for example:

> Ask Pi to review the current working tree using provider/model at max thinking. Allow it to read `/absolute/reference`, but do not grant writes.

The skill preserves the CLI's private report and work-log path markers. If a failure includes `[REVIEW_RPC_OUTPUT_LIMIT]` and `[PIONEER_REVIEW_RESUME] TOKEN`, it runs exactly `pioneer review --resume TOKEN`.

Resume keeps the source, grants, model, thinking, Pi-home, network policy, and sandbox unchanged. Use `--no-resume` only when the caller explicitly requests an ephemeral new review.

## Other coding agents

Pioneer does not require a Codex- or Claude-specific runtime. Any coding agent that can execute local commands can use the CLI.

For agents that support Agent Skills but not Agent Plugins packages, clone or download Pioneer and copy the shared skill into the agent's configured skills directory:

```bash
cp -R /absolute/path/to/pioneer/plugins/pioneer/skills/pioneer /path/to/agent/skills/
```

On Windows, use the equivalent PowerShell copy:

```powershell
Copy-Item -Recurse C:\path\to\pioneer\plugins\pioneer\skills\pioneer C:\path\to\agent\skills\
```

Restart the agent or begin a fresh session after installation. Confirm that its terminal can resolve both commands:

```bash
command -v pi
command -v pioneer
```

For an agent without skill support, add [`SKILL.md`](../plugins/pioneer/skills/pioneer/SKILL.md) to its project or system instructions. Require these steps:

- Run `pioneer doctor` before the first macOS/Linux delegation.
- Keep requested model and thinking values exact.
- Poll any returned terminal session ID until the terminal returns an exit code.
- Preserve exit status, stdout, and stderr.
- Obtain explicit approval before unsandboxed Windows execution.

An agent can also invoke Pioneer directly without installing the skill. Use the examples in [Reviewing code](reviewing-code.md) and [Skill evals](skill-evals.md).

## What the skill enforces

Before a review, the skill:

1. checks for Pi and Pioneer;
2. runs `pioneer doctor` on macOS or Linux;
3. preserves an exact requested model and thinking level;
4. makes every extra path or network grant explicit;
5. refuses to silently weaken isolation, substitute a model, or enable unsandboxed Windows execution.

If the agent's terminal sandbox hides Pi configuration, `doctor` checks the permission denial without reading configuration contents. The skill requests explicit approval to rerun the controller in an escalated or unsandboxed terminal. Pioneer's native actor sandbox remains enabled.

The CLI remains the authority. Even if an agent misses a preflight step, the runner independently validates Pi, the model selection, path grants, and platform support.

## Updating a local installation

Plugin clients can cache installed files. After changing the skill or a manifest, validate and reinstall the package from the same local marketplace. Start a new agent session. [Plugin packaging](../docs/PLUGIN-PACKAGING.md) lists maintainer commands.

## Uninstalling

Use the plugin manager in the relevant client:

```text
# Claude Code
/plugin uninstall pioneer@pioneer
```

```bash
# Codex
codex plugin remove pioneer@pioneer
```

Removing the plugin does not remove Pi, Pioneer, or your Pi agent directory.
