# Pioneer

![Pioneer: a cheerful Pi explorer holding a flag in a jungle](plugins/pioneer/assets/pioneer-banner.jpg)

Pioneer lets coding agents run independent code reviews and isolated skill evaluations through a local [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Pi uses its configured providers and models. Pioneer checks readiness, copies Pi configuration, applies path grants, and starts the native sandbox. You can select a thinking level up to `max`.

`pioneer check-comments` scores changed comments against the task scope using a dedicated decision model. General-purpose LLMs typically cost more per comment and can be less accurate. On macOS and Linux, you can explicitly select an LLM with `--provider pi --model PROVIDER/MODEL`. Pioneer never switches to an LLM automatically. [Comment-check CLI reference](https://github.com/rock3r/pioneer/blob/main/docs/CLI-REFERENCE.md#pioneer-check-comments)

## Platform support

| Platform | Reviews | Skill eval actors |
| --- | --- | --- |
| macOS | Enforced with Seatbelt | Enforced with Seatbelt |
| Linux | Enforced with Bubblewrap | Enforced with Bubblewrap |
| Windows | Explicit opt-in, instruction-only | Unsupported; fails closed |

On macOS and Linux, source and reference directories are read-only. Pi receives private writable scratch and the extra capabilities you grant. The authenticated proxy's `full` mode allows other LAN hosts and public destinations. `public` uses public destinations by default, and `provider-only` restricts egress to the selected model provider and explicit host grants. All native tiers block loopback through the proxy. An eval can open a specific local service with `--allow-loopback 127.0.0.1:PORT`.

Use `--controller-provider-auth` to keep a supported model's credentials in the controller during native reviews and Pi evals. Select a qualified model declared in the source Pi home's `models.json` with a public HTTPS endpoint. [Controller-only authentication](https://github.com/rock3r/pioneer/blob/main/docs/CLI-REFERENCE.md#controller-only-provider-authentication) lists supported protocols and options.

Pioneer invokes the native sandbox mechanisms directly. It does not depend on Anthropic Sandbox Runtime and does not impose special bans on `.idea`, `.vscode`, or other source-tree names.

When invoking Pi, run the Pioneer controller outside any enclosing agent sandbox so it can reach Pi configuration and the selected provider. Pioneer starts the Pi actor inside its own native sandbox on macOS and Linux.

## Quick start

Pioneer requires Node.js 22.19.0 or newer and npm. Reviews, skill evals, and Pi-backed comment checks require a configured Pi installation at version `0.80.6` or newer. Compatibility is tested through Pi `1.6.1`. Pioneer allows newer versions and prints a warning. Git-backed reviews and comment checks require Git 2.45 or newer.

Install the command-line interface (CLI) with npm.

```bash
npm install -g @rock3r/pioneer
```

Pioneer checks for a newer npm release in the background at most once per day and reports it after your command finishes. Check or install one manually with:

```bash
pioneer check-update
pioneer update --changelog --yes
```

To install from a trusted source checkout instead:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi # use /login to configure a provider

# From a trusted Pioneer checkout:
cd pioneer
npm ci --ignore-scripts
npm run build
npm link
pioneer doctor
pioneer models
```

If `doctor` reports a Pi catalog or configuration error, rerun Pioneer in an unsandboxed or approved escalated terminal first. An outer sandbox can hide configuration or block Pi's required lock files. Either problem can produce a catalog error. Pioneer checks metadata for this diagnosis without reading configuration contents. Its own actor sandbox remains enabled.

On macOS or Linux, run a review from the repository root to inspect current Git changes:

```bash
pioneer review \
  --source "$PWD" \
  --git working-tree \
  --prompt "Review all current working-tree changes. Report concrete correctness, security, and regression findings with file and line references." \
  --model provider/model \
  --thinking max
```

Pioneer first prints `[PIONEER_WORK_LOG] /absolute/path.jsonl` to stderr. It writes controller stages and sanitized Pi activity to that JSON Lines (JSONL) file throughout the review. Readiness failures also leave a diagnostic log. A missing or ambiguous model stops the review and prints the configured model list before Pi launches.

Logs use mode `0600` on macOS and Linux. Default Windows logs use the per-user `%LOCALAPPDATA%` access control list (ACL). Pass `--work-log /absolute/path.jsonl` for a create-only target. Custom Windows targets inherit their parent ACL, so choose a directory already private to your user.

Pioneer prints the final Markdown report to stdout and saves a private copy through a reservation owned exclusively by the controller. It announces `[PIONEER_REPORT] /absolute/path.md` on stderr. Use `--report /absolute/path/report.md` to change the destination. Pi cannot write to either controller-owned output file.

The controller collects Git context with allowlisted read-only commands and adds it to the prompt. Pi has no shell on macOS or opt-in Windows. Other scopes use `--git staged`, `--git commit:REF`, or `--git range:FROM...TO`. Without `--git`, Pioneer infers conservative targets from Git-target prompts.

Source-only prompts such as `Review the implementation under src/auth for correctness and regressions.` do not collect Git context.

## Install for your agent

All integrations require `pi` and `pioneer` on the agent's `PATH`. The plugin calls the shared CLI. Install Pi and configure credentials separately.

### Agent Plugins v1 clients

Pioneer's [`plugin.json`](plugins/pioneer/plugin.json) follows [Agent Plugins v1](https://agent-plugins.org/specification). Load `plugins/pioneer/` through your client's local-plugin installer. Compatible clients find the shared Agent Skill under `skills/`. Each client defines its own installation commands.

### Codex

After the GitHub repository is published:

```bash
codex plugin marketplace add rock3r/pioneer
codex plugin add pioneer@pioneer
codex plugin list
```

For a local checkout, replace `rock3r/pioneer` with the absolute repository path. Start a new Codex task after installation so the skill is loaded.

### Claude Code

After the GitHub repository is published:

```bash
claude plugin marketplace add rock3r/pioneer
claude plugin install pioneer@pioneer
claude plugin list
```

For a local checkout, replace `rock3r/pioneer` with the absolute repository path. The same flow is available inside Claude Code as `/plugin marketplace add`, `/plugin install`, and `/reload-plugins`.

### Other coding agents

If the agent supports Agent Skills but not Agent Plugins packages, clone or download this repository and copy [`plugins/pioneer/skills/pioneer`](plugins/pioneer/skills/pioneer) into its configured skills directory:

```bash
cp -R /absolute/path/to/pioneer/plugins/pioneer/skills/pioneer /path/to/agent/skills/
```

If the agent has no skill system, add [`SKILL.md`](plugins/pioneer/skills/pioneer/SKILL.md) to its project or system instructions, or have it invoke the `pioneer` CLI directly. See the [complete plugin and generic-agent guide](user-guide/plugins.md).

## Documentation

- [User guide](user-guide/README.md)
- [Technical documentation](docs/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [CLI reference](docs/CLI-REFERENCE.md)
- [Isolated skill evals](docs/EVALS.md)
- [Plugin packaging](docs/PLUGIN-PACKAGING.md)
- [Releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](.github/SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
npm ci
npm run check
npm run sandbox:smoke
```

Continuous integration (CI) runs quality and packed-artifact checks on macOS, Linux, and Windows. macOS and Linux also test their native sandboxes. Windows checks that unsupported evals fail closed. Tagged releases must pass the same checks before publication of the tested tarball. See [Releasing](docs/RELEASING.md).

Read [AGENTS.md](AGENTS.md) before changing production code. Run the live security boundary smoke test on both macOS and Linux for release candidates.

## Current boundaries

- Reviews are synchronous and return free-form Markdown.
- Git-target reviews collect allowlisted read-only Git context in the controller on every platform. Linux Pi additionally has `bash` inside Bubblewrap; macOS and opt-in Windows keep Pi on `read` and `ls`.
- Windows reviews require `--allow-unsandboxed-windows` after explicit user approval. Source immutability relies on instructions. Host filters, provider-only networking, and controller-only authentication require macOS or Linux.
- The eval harness prepares and isolates baseline and with-skill actors; automated grading remains separate work.

## License

Pioneer is source-available under the [Unenshittifiable License (UEL) v1.0](LICENSE). See [uelicense.eu](https://uelicense.eu/) for an overview and comparison with other licences.
