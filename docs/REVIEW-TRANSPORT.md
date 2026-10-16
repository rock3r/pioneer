# Review transport

## Public interfaces

The executable entry point is:

```text
pioneer review --source DIR --prompt TEXT [options]
```

The TypeScript API is:

```ts
import { runReview } from "@rock3r/pioneer";

// Controller-collected Git context works on every platform.
const result = await runReview({
  sourceDir: "/absolute/repository",
  gitTargets: ["working-tree"],
  prompt: "Review the current changes",
  model: "provider/model",
  thinking: "high",
  piHomeIncludes: ["skills/my-local-skill"],
  onWorkLogReady: (path) => console.error(`work log: ${path}`),
});
```

`ReviewRequest.gitTargets` accepts multiple Git inspection targets: `working-tree`, `staged`, `untracked`, `commit:REF`, `range:FROM...TO`, or `range:FROM..TO`. Without it, Pioneer infers conservative targets from Git-target prompts. It rejects GitHub pull-request URLs. Collected Git output enters the prompt as untrusted context. Pi gets no shell on macOS or Windows.

`ReviewRequest.piHomeIncludes` selects exact paths relative to the chosen Pi home. Use it for required extra files or directories, including managed package directories. It accepts multiple paths but no globs, negation, or persistent configuration. The snapshot uses the CLI's hard exclusions and symlink checks.

`ReviewRequest.controllerScratchBase` selects a controller-owned base for private scratch directories. [Path and network construction](#path-and-network-construction) describes its platform, ownership, overlap, stability, and path-length checks.

`ReviewRequest.workLogPath` selects an absolute create-only work log. `onWorkLogReady` runs synchronously after Pioneer opens it, before report reservation, readiness, or actor work. Report setup failures therefore still leave a discoverable diagnostic log.

`onReportReady` runs after Pioneer exclusively creates a private report reservation and a randomly named controller-owned sibling link. A random ownership marker binds the reservation to the controller's OS process-start identity. Pioneer writes through that inode, syncs it, and checks the target's identity. Closing the handle and removing siblings are then best-effort cleanup. They cannot rewrite the durable report.

A separate random publication lease stays marked while report bytes change, so retention treats the target as active. Pioneer restores the reservation marker if writing fails before durable publication. It never overwrites or deletes a replacement target. Failure cleanup removes only state whose identity and marker it still owns.

Retention recognizes active reservations through reservation or publication siblings. It protects a live sidecar before the target link exists and gives incomplete markers one minute for setup. Concurrent retention therefore cannot interrupt reservation creation, and model text cannot impersonate an active owner. After the controller exits, retention reclaims abandoned siblings. Later default-report passes remove inactive post-publication hard links, keeping hidden copies within the visible retention bound. An orphaned sidecar cannot block a new reservation for an absent target.

`ReviewRequest.maxRpcOutputBytes` accepts integral bytes from 1 MiB through 64 MiB, with a 20 MiB default. The CLI's `--max-rpc-output-mb` accepts integral MiB. `ReviewRequest.resumable` defaults to true. Setting it to false uses `--no-session` and neither creates nor prunes resume storage.

`ReviewResult` contains:

- the Markdown `report` and absolute `reportPath` and `workLogPath`;
- optional effective `model` and `thinking`, a `sandboxed` boolean, and an optional Windows warning;
- an optional `resumeToken` if report delivery failed;
- optional `cleanupError`, `reportWriteError`, and `workLogWriteError` for cleanup, report persistence, or close-time log persistence failures after report verification.

Callers must present the verified report before treating these errors as terminal. The CLI prints it and exits nonzero.

Only the report goes to stdout. Pioneer sends `[PIONEER_WORK_LOG] ABSOLUTE_PATH` and `[PIONEER_REPORT] ABSOLUTE_PATH` immediately to stderr, along with any resume token, errors, or Windows warning. Another Pioneer process cannot claim the reserved private report file. Until verified persistence starts, it contains only the ownership marker.

## Target semantics

`--source` grants Pi a directory and makes it the working directory. For Git-target reviews, it must be the repository root. On every platform, the controller collects bounded read-only Git context and adds it to the prompt as untrusted repository output. Prefer an explicit `--git` target:

- `--git working-tree` for tracked and untracked working-tree changes
- `--git staged` for the index
- `--git untracked` for untracked paths only
- `--git commit:REF` for a validated commit or tag
- `--git range:FROM...TO` or `--git range:FROM..TO` for a validated revision range

Without `--git`, Pioneer infers the same conservative targets from Git-target prompts. It rejects GitHub pull-request numbers and URLs; use a local `--git` target. Source-only prompts such as `Review the implementation under src/auth for correctness.` do not collect Git.

Pi uses allowlisted built-in inspection tools in the granted source tree. The native sandbox keeps the source read-only. Linux also permits `bash` inside Bubblewrap. macOS and Windows use `read`, `ls`, and controller-collected Git context. Windows has no native sandbox and requires unsandboxed opt-in.

## Readiness and model resolution

Readiness prepares private configuration and enabled-extension snapshots before model discovery. Pioneer requires:

1. `pi --version` to be semantic and at least `0.80.6`; versions newer than the tested maximum continue with a warning;
2. sandboxed model discovery with staged enabled user extensions to return at least one configured model;
3. an explicitly requested model to resolve unambiguously.

Pioneer matches the whole qualified `provider/model` name without case sensitivity. It accepts an unqualified ID only if exactly one configured provider exposes it. Missing or ambiguous requests fail with a sorted qualified model list.

See [Pi compatibility](PI-COMPATIBILITY.md) for the supported range and release procedure. If Pi cannot load `models.json`, Pioneer rejects the partial catalog before resolving models. `pioneer models` uses the review catalog parser and readiness checks.

If Pi returns no models, the controller checks only metadata with `access` on the selected Pi agent directory and known configuration filenames. `EACCES` or `EPERM` produces a client-neutral diagnostic asking for escalation or bypass of the calling agent's outer terminal sandbox.

Some policy sandboxes let `access(2)` succeed while hiding file contents. A recognized outer-agent sandbox indicator therefore produces the same diagnostic when the model list is empty. Unknown callers can set `PIONEER_OUTER_SANDBOX=1`. The probe never reads configuration contents or reports environment values. Terminal escalation leaves Pioneer's review sandbox enabled.

Set thinking with `--thinking` or a suffix such as `--model provider/model:max`. An explicit `--thinking` overrides the suffix. The supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Pi startup contract

Reviews invoke `pi --mode rpc` and add these defaults unless the caller already supplied an incompatible explicit option:

- `--offline`;
- a private `--session-dir` for new resumable reviews, or `--no-session` only for `resumable: false` / `--no-resume`;
- `--no-approve`;
- `--no-extensions` plus explicit paths from the enabled user snapshot, preventing ambient or project-local discovery;
- Linux: `--tools read,bash,grep,find,ls`; macOS and opt-in Windows: `--tools read,ls`;
- `--no-mcp` on Pi 1.0.4 or newer, because `--tools` keeps MCP tools unless an entry starts with `mcp__`. A tool-restricted Pi actor with no known Pi version at launch fails closed with `[PI_NO_MCP_VERSION_UNKNOWN]`;
- `--no-prompt-templates`;
- `--no-themes`;
- `PI_OFFLINE=1`;
- `PI_TELEMETRY=0`.

Offline mode disables optional Pi startup network activity. The running agent can still request its selected provider. Reviews use Pi RPC, enabled provider/auth hooks, and a separate inspection-tool policy. See [Pi extensions](PI-EXTENSIONS.md).

Pioneer excludes `write` and `edit`. macOS and opt-in Windows reviews use `read` and `ls` without a child-process tool. macOS also denies process creation through Seatbelt. The controller collects Git context on those platforms. Linux also keeps `bash`, `grep`, `find`, and `ls` inside Bubblewrap's PID namespace. Pioneer does not require subagents, MCP, or other optional extensions.

## RPC framing and completion

The controller writes one LF-delimited request:

```json
{"id":"review","type":"prompt","message":"..."}
```

Pioneer reads stdout as JSONL protocol data. Malformed JSON causes termination and review failure. The collector accepts text deltas and final assistant messages from Pi events, including `message_update`, `message_end`, `turn_end`, and `agent_end`.

Pioneer waits for the child and its stdio pipes to close before returning any terminal outcome, including after timeout or protocol failure. Success requires `agent_settled`, a non-empty assistant report, exit code zero, no terminating signal, and RPC pipes that closed without forced disconnection.

Pioneer converts each RPC record into a restricted work-log event as it arrives. It keeps allowlisted event types/subtypes and tool names, short tool-call ID hashes, byte counts, retry counters/delays, and booleans. For Pi-controlled reasons and diagnostics, it keeps only presence/size metadata. It never saves unrestricted Pi strings, payloads, prompt excerpts, or diagnostic text.

Events outside the allowlist use `unrecognized`. Known but unsummarized Pi session events, such as `queue_update`, also get `unrecognizedEventType` with their name. Other events get a 16-character SHA-256 prefix in `unrecognizedEventTypeHash`. Untrusted type strings could contain secrets.

An `extension_ui_request` records only its allowlisted `extensionUiMethod`. Reviews have no user to answer dialogs, so Pioneer immediately answers `select`, `confirm`, `input`, and `editor` with `{"type":"extension_ui_response","id":ID,"cancelled":true}`. It records `pi_extension_dialog_cancelled` and the method. The extension receives its documented cancelled value. Non-blocking requests such as `setWidget` need no answer.

Stderr adds byte-count activity records. `[REVIEW_RPC_INCOMPLETE]` and `[REVIEW_PROCESS_FAILED]` also add an allowlisted stderr summary, described below. A five-second heartbeat records the last allowlisted event, idle duration, RPC/stderr byte counts, and child PID. Missing heartbeats help distinguish a stalled controller/event loop from a live controller waiting on silent Pi.

Raw RPC stdout has a cumulative 20 MiB default cap. Callers can select 1 through 64 MiB. Pioneer counts bytes before JSON decoding and emits one sanitized `pi_rpc_near_limit` event at each of 75% and 90%. Exceeding the cap terminates the run with `[REVIEW_RPC_OUTPUT_LIMIT]`.

The independent work-log cap is 16 MiB per run. At the cap, Pioneer writes `work_log_truncated` and terminates with `[REVIEW_WORK_LOG_WRITE_FAILED]`. After the first 1,000 thinking/text/tool delta metadata events, it batches counts by type/subtype in fixed five-second windows. This reduces log volume for the default RPC bound.

Default Windows work logs inherit the per-user `%LOCALAPPDATA%` directory ACL. A custom Windows `workLogPath` inherits its existing parent ACL, which Pioneer cannot validate; callers must use a parent already private to the current user.

Pioneer kills the process on timeout, malformed output, protocol rejection, or output overflow. macOS and Linux use a dedicated RPC launcher process group and kill that group. Windows uses canonical system `taskkill.exe /T`, with direct termination as a fallback if the utility fails or cannot run. macOS denies process creation, keeping review activity in the controller-owned Pi process.

While the direct child runs, Pioneer forwards `SIGINT` and `SIGTERM` to its tree before returning an interrupted outcome. After the child exits, inherited output pipes have a bounded grace period to close. Pioneer force-closes remaining pipes to release resources and fails with `[REVIEW_PROCESS_CONTAINMENT_FAILED]`. It cannot report success without proof that the process tree stopped.

Pioneer reports failures after cleanup, with final child exit status, signal, and stderr-presence metadata. RPC launch uses no shell.

Terminal failures go to stderr and return nonzero:

- `[REVIEW_REPORT_MISSING]`: Pi settled without a non-empty assistant report.
- `[REVIEW_ASSISTANT_FAILED]`: Pi reported an error or abort, even if it produced partial output.
- `[REVIEW_RPC_INCOMPLETE]`: the process ended before `agent_settled`.
- `[REVIEW_PROCESS_FAILED]`: Pi settled with a report, then exited nonzero or by signal.
- `[REVIEW_PROCESS_CONTAINMENT_FAILED]`: a descendant retained an RPC pipe after the direct child exited, preventing proof that the tree stopped.

Pioneer suppresses provider and assistant diagnostic text. These errors expose only bounded presence and count metadata for supplied diagnostics. Early or nonzero exits add `Pi stderr summary:` to `[REVIEW_RPC_INCOMPLETE]` and `[REVIEW_PROCESS_FAILED]`. `[REVIEW_REPORT_MISSING]` and `[REVIEW_ASSISTANT_FAILED]` also add it if Pi settled, then exited nonzero or by signal.

The summary uses fixed allowlists: error class, known Node error code and syscall, controller-staged extension package names from the stack, and Pioneer adapter diagnostic codes. For example: `error=Error; code=EPERM; syscall=spawn; package=pi-subagents`. It excludes stderr text and paths. Untrusted stderr can contain credentials that pattern redaction misses. Readiness `[PI_PROBE_FAILED]` adds the same summary of probe output as `Pi output summary:`.

## Path and network construction

After validation, the controller creates a private `pir-*` directory under `/tmp` on macOS/Linux or `os.tmpdir()` on Windows. It contains the writable Pi snapshot, isolated home, temporary directory, and scratch. API callers can select `controllerScratchBase` instead. Pioneer rejects broad, protected, unstable, actor-granted, or overlong bases. Linux also reserves socket-path space for the authenticated proxy bridge. Required Node, Pi, TLS, and OS runtime files get read-only grants.

Choose `full` or `public` networking; see [SECURITY.md](SECURITY.md). Pioneer rejects `--network none` before launch because the model provider needs proxy-mediated egress. The sandbox gets proxy variables but no direct destination grant.

## Result and cleanup

The report contains Pi's final assistant text without surrounding whitespace. Pioneer leaves severity and file references unchanged and does not convert the report to JSON. Every strictly successful review saves a private controller-owned report through its reservation. `--report` changes only the target. Calling agents must identify it as Pi's independent review. They can add their own analysis separately.

## Native session recovery

New reviews create a private Pi session archive under the per-user application-data root. A controller-only manifest stores immutable scope metadata beside one active attempt directory. Pioneer neither parses nor exposes native session content. The saved prompt excludes execution-local scratch paths.

After proving containment, Pioneer can retain a regular tree with exactly one native `.jsonl` session for seven days, with at most ten archives. A committed attempt cannot exceed 32 MiB/5,000 entries. This reserves space for a crash-safe copy within the total archive cap of 64 MiB/10,000 entries.

Expiry and count pruning acquire the resume lease before deletion. Count pruning rechecks manifest ordering under the candidate lease, preserving concurrently claimed or newly retained recovery points. Token loading acquires the lease before validating contents. It releases the lease on failure or holds it through resume setup and execution on success. Before copying, resume removes staging attempts left by crashes while holding the lease. Success deletes the archive.

Pioneer never fabricates a report or usable token for these failures:

- a missing, ambiguous, or torn native session;
- symlinks/special files or archive size/count limits;
- failed containment, retry-layout exhaustion, or an active-lease conflict;
- a Pi-version mismatch;
- an explicit or derived default output inside any retained archive.

`pioneer review --resume TOKEN` validates report and work-log paths outside the entire private resume store. It copies the latest attempt into a new directory and selects the session by exact path. Previous attempts remain intact if the retry fails.

Pioneer removes proxy servers, Linux bridges, copied Pi state, and scratch on every success or failure path. The controller-owned work log remains, with cleanup and terminal outcome records. After strict completion passes, Pioneer prints the report to stdout and saves it through the owned reservation. `--report /absolute/path/report.md` overrides the target. Persistence failure preserves stdout but exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`. Use `--allow-write` only when Pi must create extra artifacts.

Pi 0.84.1's hidden interactive `/debug` command writes `pi-debug.log` with rendered terminal state and complete LLM messages. Pioneer never invokes or copies it. Resumable RPC reviews use Pi's native session directory; `--no-resume` keeps the temporary no-session behavior. The documented RPC stream supplies real-time Pi diagnostics.

Pi's stdout pipe delivers RPC events. Pioneer synchronously flushes sanitized metadata to its work log. It uses no filesystem watchers, polling, or `subagent-results` directory. A calling agent's `fs.watch` fallback is outside Pioneer and does not deliver the report.

## Deep review structured actors

Deep review shares `runReview`'s RPC transport, containment, timeout, work-log, and native recovery contracts. Its actors emit versioned JSON instead of Markdown. Each council member and president uses the shared Pi command builder. Launch includes `--no-builtin-tools`, disabled discovery, a bundled inspection extension, the enabled user extension snapshot, and optional pinned capability-profile provider extensions.

Before launch, the controller copies the packet and any president candidate store into private actor scratch. It passes the actor-local paths through environment variables. Actors can read those copies inside the OS sandbox without write access to controller scratch or credentials.

Pioneer treats structured actor prompts and raw model output as untrusted. JSON extraction uses free-form review output limits. Worker and president schema validation fails closed. Work logs never contain model prose or thinking.

Deep-review logs record controller lifecycle events: worker/president start and outcome. They do not yet include structured actor RPC metadata. Actor failures produce deep-review diagnostics with the containment guarantees of `[REVIEW_PROCESS_CONTAINMENT_FAILED]` and `[REVIEW_TIMEOUT]`.
