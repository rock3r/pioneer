# Troubleshooting

## Start with doctor

On macOS or Linux:

```bash
pioneer doctor
```

The command prints JSON and exits nonzero when Pi, configured models, or the native sandbox shared by reviews and evals is unavailable.

Run the Pioneer controller outside any enclosing agent sandbox. It needs the operator's Pi configuration and provider connection. Pioneer then starts the Pi actor inside its own native sandbox.

## Pi version is unsupported

Run `pioneer --version` and `pi --version` to identify both versions. Pioneer requires Pi `0.80.6` or newer. Above the tested maximum, it continues with `PI_VERSION_UNTESTED`. `pioneer doctor` includes this warning in machine output.

Replace Pi with an official release if its version is non-semantic or it lacks documented flags for its reported version.

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

First check whether Pioneer was launched inside an outer agent sandbox. Such a sandbox can prevent Pi from creating a lock directory next to its configuration and make a healthy catalog appear invalid. Rerun `pioneer doctor` from an unsandboxed or approved escalated terminal before editing `models.json`.

Run Pi directly to see its detailed validation message:

```bash
pi --offline --no-approve --no-extensions --list-models
```

Fix every reported `models.json` error, then rerun `pioneer models`. Pioneer deliberately does not repeat Pi's raw configuration error because it may contain provider-specific details.

## Thinking level rejected

Pioneer recognizes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi, the provider, and the model determine which levels work. Select a supported level explicitly. Pioneer never lowers it automatically.

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

Pioneer rejects `--network none` before review launch because Pi needs access to its model provider. Start a new review with `public`. Use `full` when the review also needs LAN or loopback access. Both modes route traffic through the proxy. Ambient extension discovery stays disabled.

On Linux, programs must honor standard HTTP(S) proxy variables. Raw TCP clients cannot escape the isolated network namespace. Enable `PIONEER_DEBUG=1` only for limited proxy diagnostics and never publish its output without inspecting it.

## A reference directory is invisible

Pass every external reference explicitly with a canonical absolute path:

```bash
--allow-read /absolute/path/to/reference
```

Do not rely on a symbolic-link shortcut in the source tree. The sandbox resolves access at the real target, which is unavailable unless separately granted.

## Pi home exceeds a snapshot limit

Pioneer selects known root configuration files and, for reviews, the sanitized `skills/` tree. Default traversal skips package and runtime content. Hard exclusions cover sessions, logs, `.npm`, `.cache`, transient directories, and log files. macOS and Windows match exclusions without case sensitivity.

The 500,000-entry and 1 GiB limits count selected content only. For required review packages or machine-specific directories, repeat `--pi-home-include RELATIVE_PATH` with exact paths. Extra paths increase storage and runtime costs and reduce portability. Evals have no include option.

`[PI_HOME_SYMLINK_TARGET_MISSING]` means a selected skill links to a path excluded by default. Add that relative target with `--pi-home-include` if policy permits it. Remove broken, escaping, special-file, hard-excluded, or ambiguous links, or replace the skill with a self-contained copy.

## Pi's session directory cannot be located

Pioneer must know where Pi stores private sessions so it can keep them out of snapshots. It reads `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting the same way Pi does, including `~/` paths, `file://` URLs, and Git Bash or WSL drive paths on Windows.

- `[PI_SESSION_DIR_RELATIVE]`: the value is a relative path. Pi resolves it against its own working directory, which Pioneer cannot know. Set an absolute path, or a path starting with `~/`.
- `[PI_SESSION_DIR_INVALID]`: the value is a `file://` URL that does not name a local path. Use a local absolute path.
- `[PI_RUNTIME_STORAGE_UNREADABLE]`: Pioneer could not read Pi's `settings.json`. The error code in parentheses, such as `EACCES` or `EISDIR`, gives the reason. Make the file readable by the current user, or remove a directory that replaced it.

## An eval run fails before the model answers

Inspect the file named by `[PIONEER_EVAL_WORK_LOG]`. Its JSONL records identify failures during readiness, snapshot, proxy, isolation probes, or actor execution.

Pi needs write access to create `auth.json.lock` in the isolated Pi home. Pioneer grants that snapshot directory write access and never mounts the real Pi home. Older read-only snapshots could produce `Credential store read failed` errors naming `auth.json.lock`.

`[EVAL_TIMEOUT]` and `[EVAL_PROCESS_CONTAINMENT_FAILED]` include any captured stdout/stderr. `[EVAL_WORK_LOG_CREATE_FAILED]` and `[EVAL_WORK_LOG_WRITE_FAILED]` mean the run stopped because it could not stay observable.

## An extension fails to load or stage

`[PI_EXTENSION_LOAD_FAILED]` names failing extensions by their last two path segments. It names missing modules by their path below `node_modules`. For example: `entry 1 (compose-pi/provider.ts): missing dependency @earendil-works/pi-ai/dist/compat.js/api/openai-completions`.

Pioneer omits names that resemble credentials or contain unusual characters. It never prints raw errors. Pioneer stops on any extension-load failure. Normal Pi can silently skip the same extension, so a normal Pi run can hide this problem.

Fix or disable the failing extension. For an eval that needs no user extensions, add `--no-extensions` to the Pi command.

`[PI_EXTENSION_SNAPSHOT_LIMIT]` identifies the exceeded limit and staged totals: 1 GiB or 500,000 entries. A separate message reports directories with more than 500,000 entries to scan. Scanning counts skipped content such as `.git`. Move the extension into a smaller dedicated directory.

In evals, `--pi-extension` shares the snapshot budget with enabled user extensions. The message identifies their contribution. Add `--no-extensions` to the Pi command to exclude user extensions. The explicit `--pi-extension` still loads.

On macOS, `spawn EPERM` can mean the sandbox cannot read a helper executable, such as an MCP server. Grant the exact executable with `--runtime-read`, for example `--runtime-read ~/.local/bin/uv`. Keep its directory on `PATH`.

The actor uses private scratch as `HOME`. Pioneer rejects `--env HOME=...`. For helpers that need real-home files, pass a configurable path through `--env` and grant it through `--runtime-read`.

If the helper has no configurable path, set only its own `HOME`. For example, use `/usr/bin/env HOME=/Users/me /path/to/server` in `mcp.json`. Grant only the exact files it reads with `--runtime-read`. Only that helper sees the changed `HOME`.

On macOS, Git and other Xcode shims can work after printing cache warnings. Messages include `couldn't create cache file '/var/folders/.../xcrun_db-...'` and `DVTFilePathFSEvents: Failed to start fs event stream`.

xcrun ignores `TMPDIR` and writes its cache in the shared per-user temporary directory. Pioneer withholds that directory. Otherwise an actor could change tool-path caches used by unsandboxed commands. These warnings alone do not indicate command failure.

## An output path is rejected as writable by another user

On macOS and Linux, output ancestors must belong to you or root. Other users must not have write access unless sticky-directory rules protect your entry. This applies to `--report`, `--work-log`, `--stdout-file`, and `--stderr-file`.

Errors name the unsafe folder, for example `Eval stdout file parent is writable by another user: /shared/out`. Another user could replace it with a link into actor files. Choose a directory in your home or remove group/world write access with `chmod go-w FOLDER`.

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

## Eval timed out or returned a containment diagnostic

`[EVAL_FIXTURE_LEAK]` means a fixture path or content would reveal the expected finding. Use a realistic filename or place the variant in a separate battery. For genuine filename collisions, repeat `--allow-fixture-name GLOB`.

That option cannot waive content checks. Pioneer rejects `BUG:`, `TODO:`, and `FIXME` in any case, plus bare uppercase `TODO` and `XXX`. Remove these markers or use plain text that does not identify the defect.

`[EVAL_FIXTURE_TOO_LARGE]` means a `files[]` entry is larger than the 64 MiB fixture limit. Eval fixtures should be small. Trim the file to the part the case needs.

`[EVAL_TIMEOUT]` preserves output captured before termination. Other diagnostics identify these causes:

| Diagnostic | Cause |
| --- | --- |
| `[EVAL_PROCESS_CONTAINMENT_FAILED]` | A descendant held inherited stdout/stderr past the cleanup grace. Pioneer exits nonzero and stops accepting output. |
| `[EVAL_SHEBANG_RESOLUTION_FAILED]` | `/usr/bin/env` resolution found a cycle, exceeded its depth bound, or read an overlong unterminated shebang. |
| `[EVAL_INTERRUPTED]` | A signal interrupted the run. |
| `[EVAL_SPAWN_FAILED]` | Native launch failed. |
| `[EVAL_OUTPUT_LIMIT]` | The named output stream exceeded its bound. |

Fix invalid shebang chains. For large output such as image-heavy `pi --mode json`, use `--stdout-file FILE` or `--stderr-file FILE` outside the run directory.

Check process creation and output behavior before retrying. Keep runtime grants narrow and native isolation enabled.

## Review appears to hang

Keep the `[PIONEER_WORK_LOG] ABSOLUTE_PATH` stderr line and inspect that JSONL file's final records. Fresh five-second `heartbeat` records show a live controller. Changes to `rpcBytes`, `stderrBytes`, or `lastPiEvent` show Pi activity.

Missing heartbeats indicate a stalled controller or event loop. Fresh heartbeats with increasing `idleMs` show a live controller waiting for silent Pi activity.

`[REVIEW_WORK_LOG_CREATE_FAILED]` means Pioneer could not create the log before long-running work. `[REVIEW_WORK_LOG_WRITE_FAILED]` means a later write failed or reached the 16 MiB cap. Either error stops the review.

If close-time sync or retention fails after report verification, Pioneer prints the report to stdout. It then reports the log error and exits nonzero.

## Review completed without a report

These terminal failures exit nonzero:

| Diagnostic | Cause |
| --- | --- |
| `[REVIEW_REPORT_MISSING]` | Pi reached `agent_settled` without a non-empty assistant report. |
| `[REVIEW_RPC_INCOMPLETE]` | Pi ended before settlement. |
| `[REVIEW_PROCESS_FAILED]` | Pi settled with a report, then exited nonzero or by signal. |
| `[REVIEW_PROCESS_CONTAINMENT_FAILED]` | An inherited RPC pipe prevented proof that the process tree stopped. |

A successful no-findings review must print a non-empty report. Read it to determine the verdict. Exit zero alone cannot describe its findings.

Pioneer prints verified reports to stdout and saves them in a private default directory. It announces `[PIONEER_REPORT] ABSOLUTE_PATH` on stderr. During execution, this protected reservation can contain an ownership marker or report bytes during publication. Wait for the terminal result before reading the completed report.

`--report /absolute/path/report.md` selects another controller-owned target. It must be absent and invisible to the actor. Saving failures preserve stdout and exit nonzero with `[REVIEW_REPORT_WRITE_FAILED]`. Pioneer always removes the private Pi home and scratch after the run.

Inspect the command's exit status and stderr as well as stdout. A wrapper result such as `{"output":""}` has discarded the evidence needed to distinguish failure from success.

Pioneer reads Pi RPC events from a process pipe and does not watch `subagent-results`. An `fs.watch` to polling fallback is emitted by the calling agent runtime and does not participate in Pioneer report delivery.
