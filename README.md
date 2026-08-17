# Pioneer

![Pioneer: a cheerful Pi explorer holding a flag in a jungle](plugins/pioneer/assets/pioneer-banner.jpg)

Pioneer is a convenient, safety-conscious bridge for coding agents to delegate tasks to a locally installed and configured [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Today it supports independent code reviews and isolated skill-eval runs. You choose any configured model and a thinking level up to `max`; Pioneer handles readiness checks, an isolated Pi home, path grants, and native sandboxing.

## Platform support

| Platform | Reviews | Skill eval actors |
| --- | --- | --- |
| macOS | Enforced with Seatbelt | Enforced with Seatbelt |
| Linux | Enforced with Bubblewrap | Enforced with Bubblewrap |
| Windows | Explicit opt-in, instruction-only | Unsupported; fails closed |

On macOS and Linux, source and reference directories are read-only. Pi receives a private writable scratch directory and only the extra capabilities you grant. Review networking defaults to `full`, including loopback and LAN, and can be restricted to `public` or `none`.

Pioneer invokes the native sandbox mechanisms directly. It does not depend on Anthropic Sandbox Runtime and does not impose special bans on `.idea`, `.vscode`, or other source-tree names.

## Quick start

Pioneer requires Node.js 22.19.0 or newer, npm, and a configured Pi installation. Pi `0.80.6` is the minimum; this release is tested through Pi `0.84.2` and warns rather than blocks on newer versions. Install the CLI with:

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

If an agent terminal hides Pi configuration, `doctor` reports that access denial separately from a genuinely unconfigured Pi installation. Its diagnosis never reads configuration contents; approve outer-terminal escalation when prompted, while Pioneer continues to sandbox the Pi actor.

On Linux, run a review from the repository to inspect the current Git changes:

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review all current working-tree changes. Report concrete correctness, security, and regression findings with file and line references." \
  --model provider/model \
  --thinking max
```

Pioneer immediately prints `[PIONEER_WORK_LOG] /absolute/path.jsonl` to stderr, then flushes controller and sanitized Pi activity to that JSONL file while the review runs. It uses mode `0600` on macOS and Linux; default Windows logs rely on the per-user `%LOCALAPPDATA%` ACL. Pass `--work-log /absolute/path.jsonl` to select a create-only target; otherwise Pioneer uses the platform log directory. Windows custom targets inherit their parent directory ACL, so use only a directory already private to the current user. The final report remains Markdown on stdout and is also persisted through an exclusively owned controller reservation. Pioneer announces its path as `[PIONEER_REPORT] /absolute/path.md` on stderr; pass `--report /absolute/path/report.md` to override the private default target without granting Pi write access to either controller-owned file. Pioneer creates and announces the work log first so readiness failures are observable, then resolves model names before launching Pi. A missing or ambiguous model fails with the configured model list and leaves its diagnostic work log in place.

On macOS and opt-in Windows, use a source-only prompt such as `Review the implementation under src/auth for correctness and regressions.` Explicit Git-target prompts fail closed because those platforms do not grant Pi Git execution.

## Install for your agent

All integrations require `pi` and `pioneer` on the agent's `PATH`. The plugin is a thin adapter: it does not bundle Pi, provider credentials, or a second implementation.

### Agent Plugins v1 clients

Pioneer includes a vendor-neutral [`plugin.json`](plugins/pioneer/plugin.json) conforming to [Agent Plugins v1](https://agent-plugins.org/specification). Use your client's local-plugin installation flow to load the `plugins/pioneer/` directory; compatible clients discover the same Agent Skill from its standard `skills/` location. Installation commands are client-specific and are intentionally outside the portable specification.

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

CI runs quality and packed-artifact checks on macOS, Linux, and Windows. macOS and Linux additionally run their real native sandbox battery; Windows proves fail-closed eval behavior and builds the experimental AppContainer launcher. Tagged releases must pass the same gates before the tested tarball is published. See [Releasing](docs/RELEASING.md).

Read [AGENTS.md](AGENTS.md) before changing production code. The smoke test is a live security boundary test, not just a unit test; release candidates should run it on both macOS and Linux.

## Current boundaries

- Reviews are synchronous and return free-form Markdown.
- Linux reviews can inspect Git inside Bubblewrap. macOS and opt-in Windows provide read-only source inspection without controller-side Git execution, and fail closed for explicit Git-target requests.
- Windows cannot enforce source immutability and requires `--allow-unsandboxed-windows` after explicit user approval.
- The eval harness prepares and isolates baseline and with-skill actors; automated grading remains separate work.

## License

Pioneer is source-available under the [Unenshittifiable License (UEL) v1.0](LICENSE). See [uelicense.eu](https://uelicense.eu/) for an overview and comparison with other licences.
