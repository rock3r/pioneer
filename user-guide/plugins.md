# Agent integrations

The Codex and Claude Code packages share the same `pioneer` skill. The skill turns an ordinary review request into a call to the locally installed CLI and preserves the CLI's fail-closed behavior.

The plugin is a thin adapter. Install and configure Pi, then install the Pioneer CLI or build/link a trusted checkout, and make these commands visible on the agent's `PATH` first:

```bash
command -v pi
command -v pioneer
command -v pioneer-eval
```

No provider authentication is stored in either plugin manifest.

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

## Other coding agents

Pioneer does not require a Codex- or Claude-specific runtime. Any coding agent that can execute local commands can use the CLI.

For agents that support Agent Skills, clone or download Pioneer and copy the shared skill into the agent's configured skills directory:

```bash
cp -R /absolute/path/to/pioneer/plugins/pioneer/skills/pioneer /path/to/agent/skills/
```

On Windows, use the equivalent PowerShell copy:

```powershell
Copy-Item -Recurse C:\path\to\pioneer\plugins\pioneer\skills\pioneer C:\path\to\agent\skills\
```

Restart the agent or begin a fresh session after installation. Confirm that its terminal can resolve all three commands:

```bash
command -v pi
command -v pioneer
command -v pioneer-eval
```

If the agent does not support skills, add [`plugins/pioneer/skills/pioneer/SKILL.md`](../plugins/pioneer/skills/pioneer/SKILL.md) to its project or system instructions. At minimum, instruct it to run `pioneer-eval doctor` before the first macOS/Linux delegation, preserve requested model and thinking values exactly, and never opt into unsandboxed Windows execution without explicit approval.

An agent can also invoke Pioneer directly without installing the skill. Use the examples in [Reviewing code](reviewing-code.md) and [Skill evals](skill-evals.md).

## What the skill enforces

Before a review, the skill:

1. checks for Pi and both Pioneer executables;
2. runs `pioneer-eval doctor` on macOS or Linux;
3. preserves an exact requested model and thinking level;
4. makes every extra path or network grant explicit;
5. refuses to silently weaken isolation, substitute a model, or enable unsandboxed Windows execution.

If an agent's own terminal sandbox hides Pi configuration, `doctor` identifies the permission denial without reading the configuration. The skill asks for explicit approval before rerunning the controller in an escalated or unsandboxed terminal. Pioneer's separate native sandbox around the Pi actor remains enabled.

The CLI remains the authority. Even if an agent misses a preflight step, the runner independently validates Pi, the model selection, path grants, and platform support.

## Updating a local installation

Plugin clients may cache installed payloads. After changing the shared skill or a manifest, validate the package, reinstall it from the same local marketplace, and start a fresh agent session. Maintainer commands are in [Plugin packaging](../docs/PLUGIN-PACKAGING.md).

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
