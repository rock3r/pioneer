# Getting started

## Requirements

- Node.js 22.19.0 or newer;
- npm;
- Pi `0.80.6` or newer (versions through `0.84.2` are tested);
- at least one provider configured in Pi;
- macOS or Linux for enforced review and eval isolation.

Windows can run reviews only after explicit acknowledgement that filesystem isolation is not enforced. Strict eval runs are unavailable on Windows.

## 1. Install and configure Pi

Follow Pi's current installation instructions. The npm route is:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

Inside Pi, use `/login` and configure at least one provider. Confirm the result without optional startup checks:

```bash
pi --version
# Pioneer rejects versions below its minimum and warns above its tested maximum.
pi --offline --no-approve --no-extensions --list-models
```

Pioneer uses the authentication stored by Pi. It does not ask the calling agent for provider credentials.

## 2. Install Pioneer from source

Install the packaged CLI with:

```bash
npm install -g @rock3r/pioneer
```

To use a trusted source checkout instead, clone the repository, then build and link it:

```bash
cd pioneer
npm ci --ignore-scripts
npm run build
npm link
```

Confirm the CLI and Pi:

```bash
command -v pioneer
pioneer doctor
pioneer models
```

Use `pioneer --help`, `pioneer eval --help`, or the [CLI reference](../docs/CLI-REFERENCE.md) for complete syntax.

## 3. Linux sandbox dependency

Install Bubblewrap using your distribution package manager. On Debian or Ubuntu:

```bash
sudo apt-get install bubblewrap
pioneer doctor
```

Ubuntu may restrict unprivileged user namespaces with AppArmor. If `doctor` requests the dedicated setup:

```bash
npm run build
sudo node dist/review-cli.js eval install-linux
pioneer doctor
```

This installs a narrow root-owned Bubblewrap copy and AppArmor profile; it does not disable the restriction globally.

## 4. Exercise the sandbox

From the source checkout:

```bash
npm run sandbox:smoke
```

The live test proves that editor directories are readable, source writes fail, scratch writes succeed, outside content and metadata are unavailable, public proxy egress works, and a direct loopback bypass fails.

## 5. Run the first review

From the repository root, run a Git-target review on any supported platform:

```bash
pioneer review \
  --source "$PWD" \
  --git working-tree \
  --prompt "Review all current working-tree changes. Report only concrete correctness, security, and regression findings with file and line references."
```

The review may take several minutes. Pioneer first prints `[PIONEER_WORK_LOG] ABSOLUTE_PATH` to stderr. That private JSONL file is flushed in real time, so another terminal or calling agent can `tail -f` it to see controller stages, Pi activity, and five-second heartbeats without exposing prompts, model text, tool inputs, or tool output. macOS and Linux use mode `0600`; Windows uses the per-user log-directory ACL. A successful command prints Pi's Markdown report to stdout and removes its temporary Pi home and scratch area while preserving the work log.

By default, work logs are created under `~/Library/Logs/Pioneer/reviews/` on macOS, `${XDG_STATE_HOME:-~/.local/state}/pioneer/logs/reviews/` on Linux, and `%LOCALAPPDATA%\Pioneer\Logs\reviews\` on Windows. To choose an exact create-only target, add:

```bash
--work-log /absolute/path/review.jsonl
```

On Windows, prefer the default per-user location. A custom target inherits its parent directory ACL, so choose one only beneath a directory already private to your user account.

Pioneer collects the Git context itself and does not grant Pi a shell on macOS or opt-in Windows. Use `--git staged`, `--git commit:REF`, or `--git range:FROM...TO` for other scopes. For a source-only review that should not inspect Git, omit `--git` and use a prompt such as:

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review the implementation under src for concrete correctness, security, and regression findings with file and line references."
```

## 6. Install an agent integration

The CLI works on its own. To let an agent invoke it naturally, continue to [Agent integrations](plugins.md) and choose the Codex, Claude Code, or generic Agent Skills route.
