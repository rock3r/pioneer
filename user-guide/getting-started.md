# Getting started

## Requirements

- Node.js 22 or newer;
- npm;
- Pi `0.80.6` or newer (versions through `0.82.0` are tested);
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

Pioneer uses the authentication stored by Pi. It does not ask Codex or Claude Code for provider credentials.

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

From a repository you want reviewed:

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review all current working-tree changes. Report only concrete correctness, security, and regression findings with file and line references."
```

The review may take several minutes. A successful command prints Pi's Markdown report to stdout and removes its temporary Pi home and scratch area.

## 6. Install an agent integration

The CLI works on its own. To let an agent invoke it naturally, continue to [Agent integrations](plugins.md) and choose the Codex, Claude Code, or generic Agent Skills route.
