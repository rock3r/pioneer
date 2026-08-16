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
  piHomeIncludes: ["skills/my-local-skill"],
  onWorkLogReady: (path) => console.error(`work log: ${path}`),
});
```

`ReviewRequest.piHomeIncludes` is a repeatable exact-path opt-in relative to the selected Pi home. It is intended for a narrowly required additional file or directory, including a managed package directory; it does not support globs, negation, or persistent configuration. The shared snapshot applies the same hard exclusions and symlink checks as the CLI.

`ReviewRequest.workLogPath` selects an absolute create-only work-log target. `onWorkLogReady` runs synchronously after that file is open and before long-running readiness or actor work. `onReportReady` likewise runs only after Pioneer has exclusively created the private report reservation with a random ownership marker bound to the controller's OS process-start identity and a randomly named controller-owned sibling link; successful persistence writes through that owned inode, verifies the target still has the same identity, and then removes the link on a best-effort basis. A separate random publication lease remains independently marked while those bytes are changing, so concurrent retention still classifies the target as active; Pioneer restores the reservation marker if the write fails. It never overwrites or deletes a replacement target. Failure cleanup removes only state whose identity and marker it still owns. Retention recognizes an active reservation through the reservation or publication sibling, so model-produced report text cannot spoof one; after the owning controller exits, retention reclaims abandoned siblings, and later default-report passes also remove inactive post-publication hard links so transient cleanup failures cannot retain hidden report copies outside the visible bound. A sidecar orphaned by interruption cannot block a new reservation for an absent target. `ReviewRequest.maxRpcOutputBytes` accepts an integral byte value from 1 MiB through 64 MiB and defaults to 20 MiB; the CLI's `--max-rpc-output-mb` uses integral MiB values. `ReviewRequest.resumable` defaults to true; false restores the ephemeral `--no-session` launch and does not create or prune resume storage. `ReviewResult` contains the Markdown `report`, absolute `reportPath` and `workLogPath`, optional effective `model` and `thinking`, a `sandboxed` boolean, an optional Windows warning, an optional `resumeToken` when report delivery failed, an optional `cleanupError`, an optional `reportWriteError`, and an optional `workLogWriteError` when cleanup, report persistence, or close-time work-log persistence fails after the report has already been verified. Callers must still surface the report before treating any of these errors as terminal; the CLI prints it and exits nonzero.

The CLI prints only the report to stdout. The immediate `[PIONEER_WORK_LOG] ABSOLUTE_PATH` and `[PIONEER_REPORT] ABSOLUTE_PATH` markers, resume token, errors, and the Windows warning go to stderr. The report path names an exclusively reserved private file, so another Pioneer process cannot claim it while the review runs; until verified report persistence begins, its contents are only the in-progress ownership marker.

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
- a private `--session-dir` for new resumable reviews, or `--no-session` only for `resumable: false` / `--no-resume`;
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

Pioneer also converts each Pi RPC record into a restricted work-log event as it arrives. It retains allowlisted event types/subtypes, allowlisted tool names, a short hash of each tool-call ID, byte counts, retry counters/delays, boolean state, and presence/size metadata for Pi-controlled reasons and diagnostics. It never persists unrestricted Pi strings, payload content, prompt excerpts, or diagnostic text. Stderr contributes byte-count activity records; terminal transport diagnostics report only whether stderr was present and never return its text. A five-second heartbeat records the last allowlisted Pi event, idle duration, RPC/stderr byte counts, and child PID. Missing heartbeats distinguish a stalled controller/event loop from a live controller waiting on silent Pi activity.

The default cumulative raw RPC stdout cap is 20 MiB and callers may select 1 through 64 MiB. Pioneer counts bytes before JSON decoding, emits one sanitized `pi_rpc_near_limit` event at 75% and 90%, then terminates with `[REVIEW_RPC_OUTPUT_LIMIT]` when the selected bound is exceeded. The 16 MiB per-run work-log cap remains fail-closed: Pioneer first writes `work_log_truncated`, then terminates the review with `[REVIEW_WORK_LOG_WRITE_FAILED]`. After the first 1,000 thinking/text/tool delta metadata events, Pioneer emits fixed five-second type/subtype-counted batches so work-log volume does not preempt the new default RPC bound.

Default Windows work logs inherit the per-user `%LOCALAPPDATA%` directory ACL. A custom Windows `workLogPath` inherits its existing parent ACL, which Pioneer cannot validate; callers must use a parent already private to the current user.

The process is killed on timeout, malformed output, protocol rejection, or output overflow. On macOS and Linux, Pioneer puts the RPC launcher in its own process group and kills that group; Windows invokes the canonical system `taskkill.exe /T` and falls back to direct termination if that utility cannot run or reports failure. macOS reviews deny process creation, so all review activity remains in the controller-owned Pi process. While the direct child is running, Pioneer also forwards `SIGINT` and `SIGTERM` to that tree before returning the interrupted outcome. Whenever the direct child exits, Pioneer starts a bounded grace period for inherited output pipes. A pipe still held after that period is force-closed only to release controller resources, and the review fails with `[REVIEW_PROCESS_CONTAINMENT_FAILED]`; Pioneer never returns its report as a successful review when it cannot prove the process tree stopped. Failures are reported only after this cleanup, with the final child exit status, signal, and stderr-presence metadata. No shell participates in the RPC launch.

`[REVIEW_REPORT_MISSING]` means Pi settled but emitted no non-empty assistant report. `[REVIEW_ASSISTANT_FAILED]` means Pi reported an error or abort, even if it produced partial output before settling. `[REVIEW_RPC_INCOMPLETE]` means the process ended before `agent_settled`. `[REVIEW_PROCESS_FAILED]` means Pi settled with a report but then exited nonzero or by signal. `[REVIEW_PROCESS_CONTAINMENT_FAILED]` means a descendant retained the RPC pipe after the direct child exited, so Pioneer could not prove that the process tree stopped. All are non-zero terminal failures written to stderr. Provider and assistant diagnostic text is suppressed; terminal errors expose only bounded presence and count metadata when Pi supplies diagnostics.

## Path and network construction

After validation, the controller creates a private `/tmp/pir-*` directory containing the writable Pi snapshot, isolated home, temporary directory, and scratch space. Runtime files required by Node, Pi, TLS, and the operating system are added as read-only grants.

Networking is one of `full`, `public`, or `none`; see [SECURITY.md](SECURITY.md). The sandbox receives proxy variables but no direct destination grant.

## Result and cleanup

The report is Pi's final assistant text with surrounding whitespace removed. Pioneer does not rewrite severity, validate file references, or convert the report to JSON. Every strict-successful review persists a private controller-owned report through its owned reservation by default; `--report` only changes its target. Calling agents should present it as Pi's independent review and may separately add their own analysis.

## Native session recovery

New reviews create a private opaque Pi session archive under the per-user application-data root. The archive contains a controller-only manifest with immutable scope metadata and one active attempt directory; Pioneer never parses or exposes native session content. The persisted prompt omits execution-local scratch paths. After containment is proven, a regular session tree with exactly one native `.jsonl` session may be retained for seven days and at most ten archives. The committed attempt is capped at 32 MiB/5,000 entries, leaving room for the next crash-safe copy within the aggregate 64 MiB/10,000-entry archive cap. Expiry and count pruning acquire the same per-archive lease used by resume before deletion, so a concurrently claimed recovery point is preserved. Resume removes crash-left staging attempts while holding that lease before it creates the next bounded staging copy. Success deletes the archive. A failure caused by a missing or ambiguous native session, torn session, symlink/special-file entry, archive-size/count limit, failed containment, retry-layout exhaustion, active-lease conflict, Pi-version mismatch, or an explicit or derived default output inside the retained archive is never converted into a fabricated report or usable token. `pioneer review --resume TOKEN` validates both output kinds outside the archive, copies the latest attempt into a new attempt directory, and selects it by exact path; previous attempts remain intact if the retry fails.

Proxy servers, Linux bridges, copied Pi state, and scratch data are removed on every success or failure path. The controller-owned work log remains available after completion and contains cleanup and terminal outcome records. Pioneer prints the canonical report to stdout and persists the private controller-owned report through its owned reservation after the strict completion contract passes. `--report /absolute/path/report.md` overrides that target; a persistence error preserves stdout but exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`. Use an explicit `--allow-write` directory only when Pi itself must create additional artifacts.

Pi 0.84.1 has a hidden interactive `/debug` command that writes `pi-debug.log`, but it is an on-demand TUI snapshot containing rendered terminal state and complete LLM messages. Pioneer does not copy or invoke that unsafe dump; resumable RPC reviews use Pi's native session directory, while `--no-resume` retains the ephemeral no-session behavior. The documented RPC stream remains Pi's native real-time diagnostic source.

Pioneer receives RPC events through the Pi child process's stdout pipe and synchronously flushes their sanitized metadata to its controller-owned work log. It does not use filesystem watchers, polling, or a `subagent-results` directory. Any `fs.watch` fallback reported by a calling agent runtime is outside Pioneer and cannot be the mechanism that delivers the report.
