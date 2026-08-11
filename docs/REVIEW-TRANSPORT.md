# Review transport

## Public interfaces

The executable entry point is:

```text
pioneer review --source DIR --prompt TEXT [options]
```

The TypeScript API is:

```ts
import { runReview } from "@rock3r/pioneer";

// On Linux, this reviews the current Git changes.
const result = await runReview({
  sourceDir: "/absolute/repository",
  prompt: "Review the current changes",
  model: "provider/model",
  thinking: "high",
  onWorkLogReady: (path) => console.error(`work log: ${path}`),
});
```

`ReviewRequest.workLogPath` selects an absolute create-only work-log target. `onWorkLogReady` runs synchronously after that file is open and before long-running readiness or actor work. `ReviewResult` contains the Markdown `report`, the absolute `workLogPath`, optional effective `model` and `thinking`, a `sandboxed` boolean, an optional Windows warning, and an optional `reportWriteError` when transport succeeds but requested report persistence fails.

The CLI prints only the report to stdout. The immediate `[PIONEER_WORK_LOG] ABSOLUTE_PATH` marker, errors, and the Windows warning go to stderr.

## Target semantics

`--source` grants a directory to Pi and sets it as the working directory. Linux Pi can inspect Git directly inside its PID namespace. macOS and opt-in Windows provide read-only source inspection without controller-side Git execution and reject explicit Git-target requests rather than report on an unverified scope. On those platforms, use a source-only prompt such as `Review the implementation under src/auth for correctness.` Put the intended Linux Git scope in the prompt, for example:

- “Review all current working-tree changes.”
- “Review commit `abc123` against its first parent.”
- “Review the implementation under `src/auth` against `docs/auth-design.md`.”

Pi uses its allowlisted built-in inspection tools inside the granted source tree. The native sandbox keeps that source read-only.

## Readiness and model resolution

Readiness runs before scratch creation. Pioneer requires:

1. `pi --version` to be semantic and at least `0.80.6`; versions newer than the tested maximum continue with a warning;
2. `pi --offline --no-approve --no-extensions --list-models` to return at least one configured model;
3. an explicitly requested model to resolve unambiguously.

A qualified `provider/model` name is matched case-insensitively as a whole. An unqualified model ID is accepted only if exactly one configured provider exposes it. Missing or ambiguous requests fail with the sorted qualified model list.

The supported range and its release procedure are defined in [Pi compatibility](PI-COMPATIBILITY.md). If Pi reports a `models.json` load failure, Pioneer rejects the partial catalog before model resolution. `pioneer models` exposes the same parsed catalog and readiness behavior as reviews.

If Pi returns an empty model list, the controller performs metadata-only `access` checks on the selected Pi agent directory and known configuration filenames. `EACCES` or `EPERM` produces a client-neutral diagnostic explaining that the calling agent's outer terminal sandbox must be escalated or bypassed.

Because policy sandboxes can make `access(2)` succeed while hiding file contents, a recognized outer-agent sandbox environment indicator produces the same conservative result when the model list is empty. Unknown callers can set `PIONEER_OUTER_SANDBOX=1`. The probe never reads configuration contents or reports environment values, and terminal escalation does not disable Pioneer's own review sandbox.

Thinking may be supplied separately with `--thinking`, or as the suffix in `--model provider/model:max`. An explicit `--thinking` value takes precedence over the suffix. Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Pi startup contract

Reviews invoke `pi --mode rpc` and add these defaults unless the caller already supplied an incompatible explicit option:

- `--offline`;
- `--no-session`;
- `--no-approve`;
- `--no-extensions`;
- Linux: `--tools read,bash,grep,find,ls`; macOS and opt-in Windows: `--tools read,ls`;
- `--no-prompt-templates`;
- `--no-themes`;
- `PI_OFFLINE=1`;
- `PI_TELEMETRY=0`.

Offline mode disables Pi's optional startup network activity; it does not prevent the selected provider request once the agent is running. Review completion depends only on Pi's built-in RPC mode and built-in inspection tools. `write` and `edit` are excluded. macOS and opt-in Windows reviews use `read` and `ls`, so source discovery remains available without allowing Pi to request a child process; macOS also denies process creation in Seatbelt. Pioneer does not execute Git in its controller on those platforms. Linux reviews retain `bash`, `grep`, `find`, and `ls` inside Bubblewrap's PID namespace. Pioneer does not assume subagents, MCP, or another optional Pi extension is installed.

## RPC framing and completion

The controller writes one LF-delimited request:

```json
{"id":"review","type":"prompt","message":"..."}
```

Stdout is treated as JSONL protocol data. Malformed JSON requests process termination and fails the review. The collector accepts text deltas and final assistant messages from current Pi event variants, including `message_update`, `message_end`, `turn_end`, and `agent_end`. Pioneer does not resolve any terminal outcome merely because Pi emits `agent_settled`: it waits for the child process and its stdio pipes to close, including after timeout or protocol failure. A successful review additionally requires `agent_settled`, a non-empty assistant report, exit code zero, no terminating signal, and proof that the RPC pipes closed without forced disconnection.

Pioneer also converts each Pi RPC record into a restricted work-log event as it arrives. It retains allowlisted event types/subtypes, allowlisted tool names, a short hash of each tool-call ID, byte counts, retry counters/delays, boolean state, and presence/size metadata for Pi-controlled reasons and diagnostics. It never persists unrestricted Pi strings, payload content, prompt excerpts, or diagnostic text. Stderr contributes byte-count activity records, while its bounded text remains only in terminal transport diagnostics returned to the caller. A five-second heartbeat records the last allowlisted Pi event, idle duration, RPC/stderr byte counts, and child PID. Missing heartbeats distinguish a stalled controller/event loop from a live controller waiting on silent Pi activity.

The process is killed on timeout, malformed output, protocol rejection, or output overflow. On macOS and Linux, Pioneer puts the RPC launcher in its own process group and kills that group; Windows invokes the canonical system `taskkill.exe /T` and falls back to direct termination if that utility cannot run or reports failure. macOS reviews deny process creation, so all review activity remains in the controller-owned Pi process. While the direct child is running, Pioneer also forwards `SIGINT` and `SIGTERM` to that tree before returning the interrupted outcome. Whenever the direct child exits, Pioneer starts a bounded grace period for inherited output pipes. A pipe still held after that period is force-closed only to release controller resources, and the review fails with `[REVIEW_PROCESS_CONTAINMENT_FAILED]`; Pioneer never returns its report as a successful review when it cannot prove the process tree stopped. Failures are reported only after this cleanup, with the final child exit status, signal, and bounded stderr context. No shell participates in the RPC launch.

`[REVIEW_REPORT_MISSING]` means Pi settled but emitted no non-empty assistant report. `[REVIEW_ASSISTANT_FAILED]` means Pi reported an error or abort, even if it produced partial output before settling. `[REVIEW_RPC_INCOMPLETE]` means the process ended before `agent_settled`. `[REVIEW_PROCESS_FAILED]` means Pi settled with a report but then exited nonzero or by signal. `[REVIEW_PROCESS_CONTAINMENT_FAILED]` means a descendant retained the RPC pipe after the direct child exited, so Pioneer could not prove that the process tree stopped. All are non-zero terminal failures written to stderr. Provider or assistant diagnostics are included in the bounded error context when Pi supplies them.

## Path and network construction

After validation, the controller creates a private `/tmp/pir-*` directory containing the writable Pi snapshot, isolated home, temporary directory, and scratch space. Runtime files required by Node, Pi, TLS, and the operating system are added as read-only grants.

Networking is one of `full`, `public`, or `none`; see [SECURITY.md](SECURITY.md). The sandbox receives proxy variables but no direct destination grant.

## Result and cleanup

The report is Pi's final assistant text with surrounding whitespace removed. Pioneer does not rewrite severity, validate file references, or convert the report to JSON. Calling agents should present it as Pi's independent review and may separately add their own analysis.

Proxy servers, Linux bridges, copied Pi state, and scratch data are removed on every success or failure path. The controller-owned work log remains available after completion and contains cleanup and terminal outcome records. Pioneer prints the canonical report to stdout. When persistence is required, `--report /absolute/path/report.md` atomically creates a controller-owned report only after the strict completion contract passes; a persistence error preserves stdout but exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`. Use an explicit `--allow-write` directory only when Pi itself must create additional artifacts.

Pi 0.84.1 has a hidden interactive `/debug` command that writes `pi-debug.log`, but it is an on-demand TUI snapshot containing rendered terminal state and complete LLM messages. RPC reviews run with `--no-session` and do not expose a supported continuous native debug-log switch. Pioneer therefore does not copy or invoke that unsafe dump; the documented RPC stream is Pi's native real-time diagnostic source.

Pioneer receives RPC events through the Pi child process's stdout pipe and synchronously flushes their sanitized metadata to its controller-owned work log. It does not use filesystem watchers, polling, or a `subagent-results` directory. Any `fs.watch` fallback reported by a calling agent runtime is outside Pioneer and cannot be the mechanism that delivers the report.
