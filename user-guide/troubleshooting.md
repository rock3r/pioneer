# Troubleshooting

## Start with doctor

On macOS or Linux:

```bash
pioneer doctor
```

The command prints JSON and exits nonzero when Pi, configured models, or the native sandbox shared by reviews and evals is unavailable.

## Pi version is unsupported

Run `pioneer --version` to identify Pioneer and `pi --version` to identify Pi. Pioneer requires Pi `0.80.6` or newer. Versions above the tested maximum continue with `PI_VERSION_UNTESTED`; use `pioneer doctor` to see the warning in machine output. A non-semantic or in-range binary that lacks documented Pi flags should be replaced with an official Pi release.

## Pi is not installed

Confirm the executable is visible to the same shell or agent process that launches Pioneer:

```bash
command -v pi
pi --version
```

If needed, install the current package:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Restart the calling agent after changing `PATH`.

## No configured models

Open Pi and use `/login`, then verify:

```bash
pioneer models
```

Pioneer reads authentication from the selected Pi agent directory. It does not inherit arbitrary provider API-key variables from the host.

If the error instead says the terminal cannot expose Pi configuration, do not reconfigure Pi. The calling agent's outer sandbox is hiding the Pi agent directory, or its policy makes a metadata-only check inconclusive. Approve a scoped terminal escalation or run Pioneer from an unsandboxed terminal.

The diagnosis checks access bits and known filenames only; it never reads configuration contents or environment values, and Pioneer still sandboxes the Pi review actor. Integrations with an unrecognized sandbox can set `PIONEER_OUTER_SANDBOX=1` before invoking `doctor`.

## Model missing or ambiguous

Run `pioneer models` and copy one of its qualified `provider/model` names. Unqualified IDs are accepted only when exactly one configured provider exposes that ID. Pioneer never picks a near match or silently falls back.

If the wrong configuration is being inspected, set `PI_CODING_AGENT_DIR` or pass `--pi-home /absolute/path`.

## Invalid `models.json`

`PI_MODELS_CONFIG_INVALID` means Pi reported a load error even if it also printed built-in or cached models. Pioneer rejects that partial catalog so a broken custom provider cannot be mistaken for a missing model.

Run Pi directly to see its detailed validation message:

```bash
pi --offline --no-approve --no-extensions --list-models
```

Fix every reported `models.json` error, then rerun `pioneer models`. Pioneer deliberately does not repeat Pi's raw configuration error because it may contain provider-specific details.

## Thinking level rejected

Pioneer recognizes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but support still depends on Pi, the provider, and the model. Choose a supported level explicitly; the runner will not lower it automatically.

## Bubblewrap or user namespaces unavailable

Install Bubblewrap first. On Debian or Ubuntu:

```bash
sudo apt-get install bubblewrap
```

If `doctor` still reports Ubuntu's AppArmor user-namespace restriction, run the narrow project installer from a built source checkout:

```bash
npm run build
sudo node dist/review-cli.js eval install-linux
pioneer doctor
```

Do not disable the global user-namespace restriction. See [Linux sandbox setup](../docs/EVALS.md#setup) for exactly what the installer changes.

## Provider cannot reach the network

Check the selected mode. `none` intentionally blocks egress; `public` blocks LAN and loopback; `full` permits all three through the proxy.

On Linux, programs must honor standard HTTP(S) proxy variables. Raw TCP clients cannot escape the isolated network namespace. Enable `PIONEER_DEBUG=1` only for limited proxy diagnostics and never publish its output without inspecting it.

## A reference directory is invisible

Pass every external reference explicitly with a canonical absolute path:

```bash
--allow-read /absolute/path/to/reference
```

Do not rely on a symbolic-link shortcut in the source tree. The sandbox resolves access at the real target, which is unavailable unless separately granted.

## Pi home exceeds a snapshot limit

Pioneer excludes sessions, logs, caches, and root temporary trees before enforcing a 500,000-entry and 1 GiB snapshot budget. It deliberately retains Pi's `npm/`, `git/`, and nested `node_modules/` package content because configured review skills may require those resources; optional extension discovery remains disabled. Remove genuinely stale Pi packages with Pi's own package commands, or pass `--pi-home` with a purpose-built compatible Pi home; do not delete authentication files or configured skill dependencies blindly.

## A writable grant is rejected

Writable grants must not overlap the source or any read-only grant. Create a dedicated artifact directory and grant only that directory. For the final report alone, use `--report /absolute/path/report.md` instead of granting a write capability.

## Windows refuses to start

Strict eval runs are unsupported. Reviews require `--allow-unsandboxed-windows`, but only after you understand that filesystem access is not enforced. Agent plugins intentionally require an explicit user decision and will not add this flag on their own.

## Plugin is installed but does not trigger

Verify that `pioneer` and `pi` are on the environment inherited by the client. Reinstall or update the plugin from its marketplace, then start a new Codex task or reload/restart Claude Code.

You can also invoke the Claude skill directly as `/pioneer:pioneer`. For Codex, ask explicitly: “Use the Pioneer skill to have Pi review this repository.”

## Review timed out

The default is 900,000 ms (15 minutes). Retry with a larger positive integer only when the review legitimately needs longer:

```bash
--timeout-ms 1800000
```

Timeout cleanup kills Pi and removes the private run state.

## Review completed without a report

Pioneer exits nonzero with `[REVIEW_REPORT_MISSING]` if Pi reaches `agent_settled` without a non-empty assistant report. It exits nonzero with `[REVIEW_RPC_INCOMPLETE]` if Pi ends before settling, with `[REVIEW_PROCESS_FAILED]` if Pi settles with a report but exits nonzero or by signal, and with `[REVIEW_PROCESS_CONTAINMENT_FAILED]` if an inherited RPC pipe prevents Pioneer from proving the process tree stopped. A successful no-findings review still prints a non-empty report; exit zero alone is transport success, not a semantic verdict.

The report is always printed to stdout. With `--report /absolute/path/report.md`, Pioneer also writes the verified final report atomically; the target must not already exist and cannot be actor-visible. If that persistence fails, stdout still contains the verified report but Pioneer exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`. The private Pi home and scratch directory are always removed after the run.

Inspect the command's exit status and stderr as well as stdout. A wrapper result such as `{"output":""}` has discarded the evidence needed to distinguish failure from success.

Pioneer reads Pi RPC events from a process pipe and does not watch `subagent-results`. An `fs.watch` to polling fallback is emitted by the calling agent runtime and does not participate in Pioneer report delivery.
