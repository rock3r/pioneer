---
name: pioneer
description: Delegate a code review from a coding agent to the locally installed Pi coding agent. Use when the user asks Pioneer, Pi, another configured model, or an independent model to review code, a repository, a diff, or an implementation.
license: UEL-1.0
---

# Pioneer

Run independent reviews with the `pioneer` CLI and the operator's configured Pi installation. Keep native-session recovery enabled unless the caller explicitly chooses `--no-resume`.

## Preconditions

1. Run the `pioneer` controller outside any enclosing agent sandbox. It must reach the operator's Pi configuration and configured model provider. Pioneer launches the Pi review actor in its own native sandbox on macOS and Linux.
2. Confirm `pioneer` and `pi` are available on `PATH`.
3. On macOS or Linux, run `pioneer doctor` before the first review in a session.
   - For an ordinary readiness failure, stop and present its instructions.
   - For `PIONEER_OUTER_SANDBOX_REQUIRED`, `PI_CONFIG_HIDDEN_BY_SANDBOX`, or `PI_MODELS_CONFIG_INVALID`, explain that the outer sandbox can block configuration access or lock-file creation.
   - Request explicit approval to rerun `doctor` and the review in an escalated or unsandboxed terminal. Do this before changing Pi configuration. Do not read any Pi configuration file. Pioneer's native actor sandbox remains enabled.
   - For other diagnostic IDs, stop and present their actionable prose. Do not infer a different failure from wording.
4. On Windows, do not use `doctor` as a review readiness check because strict eval isolation is unsupported. Run `pi --version` and `pi --offline --no-approve --no-extensions --list-models` instead.
5. If the user requested a model, preserve the exact name. Let Pioneer reject unavailable or ambiguous names and show the configured qualified model list.

## Review command

When the user requests a Git-target review, run this from the repository root and pass explicit `--git` targets:

```bash
pioneer review \
  --source "$PWD" \
  --git working-tree \
  --prompt "Review the current changes for correctness, security, and regressions. Report concrete findings with file and line references." \
  --model provider/model \
  --thinking high
```

Repeat `--git` for multiple targets. Accepted values are `working-tree`, `staged`, `untracked`, `commit:REF`, `range:FROM...TO`, and `range:FROM..TO`. The controller collects Git context on every platform. Pi cannot run Git on macOS or Windows.

For a GitHub pull-request number or URL, request a local `--git` target. For source-only reviews, omit `--git`. Use a scope such as `Review the implementation under src for correctness, security, and regressions.`

Include `--model` and `--thinking` only when requested. Pass the exact requested thinking level as `--thinking <level>`. Never omit or substitute a requested value. Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Reviews save a private controller-owned report by default. Preserve stderr and both path markers: `[PIONEER_REPORT] ABSOLUTE_PATH` and `[PIONEER_WORK_LOG] ABSOLUTE_PATH`. The API exposes the report path as `ReviewResult.reportPath`.

Pioneer announces the report path after exclusively creating its private reservation file. The initial contents are an ownership marker bound to that controller instance. Wait for completion before treating the file as a report. `--report` selects another create-only controller target.

Use `--no-resume` only for an explicitly requested ephemeral Pi launch without session retention. This mode neither creates nor prunes resume storage.

Use repeated grants when the review needs more context:

```bash
--allow-read /absolute/reference/path
--allow-write /absolute/output/path
```

On native sandbox platforms, the source and `--allow-read` directories remain read-only. Use `--allow-write` only for actor-created artifacts. For the final report, use `--report /absolute/path/report.md`. Pioneer writes it through its exclusive controller reservation after review success. Pi has no write access to that target.

Pioneer creates a real-time JSONL work log and immediately prints `[PIONEER_WORK_LOG] ABSOLUTE_PATH` to stderr. Preserve that line. Use the private platform default unless the caller requests a specific create-only target through `--work-log /absolute/new-file.jsonl`. Paths must contain no control characters.

Windows custom targets inherit their parent directory ACL. Pioneer cannot validate that ACL. Use the default unless the caller identifies a parent already private to the current user.

While the terminal session runs, inspect or tail the log for status. Five-second heartbeats and sanitized Pi events show activity, silence, retries, tool execution, settlement, and termination. Records exclude prompts and model/tool content.

Networking defaults to `full`, allowing public, LAN, and loopback destinations through the authenticated proxy. Use `--network public` when local services are unnecessary. Do not use `--network none`. Pioneer rejects it before launch because Pi must reach its configured model provider. Start a new review with `--network public` instead.

Use `--pi-home /absolute/path` only when the caller provides a prepared Pi agent directory. The directory is copied into the isolated run; it is not mounted in place.

## Windows

Windows review execution is not enforceably sandboxed. Never add `--allow-unsandboxed-windows` silently. Explain that source immutability is instruction-only and obtain the user's explicit approval before proceeding. Strict eval runs are unsupported on Windows. Native extension discovery is also unsupported there; an explicitly approved built-in-only review requires `--no-extensions`.

## Extension failures

`PI_EXTENSION_*` diagnostics identify extension resolution, staging, or runtime failures. Keep the exact requested model. Do not patch installed dist files, substitute providers, disable extensions, or widen the sandbox to hide errors.

Resume rejects changed snapshots with `REVIEW_RESUME_EXTENSIONS_CHANGED`. Restore the same code and dependencies, or ask the user to start a new review.

## Presenting results

- Transport success requires that the command's exit status is zero and stdout contains a non-empty report. Read the report to determine the findings. A no-findings result must explicitly say that the review found no issues.
- Preserve the command's exit status, stdout, and stderr in any shell or tool wrapper. Do not reduce the result to stdout alone. A capture such as `{"output":""}` is insufficient evidence of either success or failure.
- `[PIONEER_WORK_LOG] ABSOLUTE_PATH` identifies the work log. Preserve the path for progress checks and hang diagnosis.
- `[PIONEER_REPORT] ABSOLUTE_PATH` identifies the report reservation. Preserve it and wait for a terminal result before reading a completed report. On transport success, it contains the private durable report.
- A terminal session ID without an exit code means the review is still running. Keep polling that session ID until the terminal returns an exit code. Report the review's own terminal result.
- Pioneer loads enabled user extensions from a private snapshot for provider/auth hooks and separately restricts extension tools; `write` and `edit` are excluded, while the native sandbox keeps the source read-only. Loading an extension does not authorize its subagent, write or MCP tools. Only add `--no-extensions` when the user explicitly requests the built-in-only opt-out.
- Pioneer receives Pi events over process pipes and does not use `fs.watch`, polling, or a `subagent-results` directory. The calling agent runtime emits watcher fallback messages. Those watchers cannot save or deliver a Pioneer report.
- Preserve concrete findings, file paths, line references, and severity from Pi's report.
- If Pioneer exits with `[REVIEW_REPORT_WRITE_FAILED]`, preserve and present the non-empty stdout Markdown report together with the persistence diagnostic; Pi's review completed, but the requested durable copy did not.
- If Pioneer exits with `[REVIEW_WORK_LOG_CREATE_FAILED]` or `[REVIEW_WORK_LOG_WRITE_FAILED]`, report it as terminal. Pioneer intentionally stops rather than continue a review that cannot be observed in real time, including after the bounded log writes `work_log_truncated`. If stdout still contains a verified report after a close-time work-log failure, preserve and present that report together with the diagnostic.
- Clearly distinguish Pi's findings from your own analysis.
- If the command fails, report the actionable error instead of retrying with a different model, weaker Pioneer sandbox, or broader path grant. The one exception is the explicit outer-terminal access error above, which requires user-approved terminal escalation and does not weaken Pioneer's sandbox.
- If stderr contains `REVIEW_RPC_OUTPUT_LIMIT` and `[PIONEER_REVIEW_RESUME] TOKEN`, run exactly `pioneer review --resume TOKEN`.
  Only timeout, bounded RPC output, controller-owned output paths, and a fresh Windows acknowledgement can change. Keep model, thinking, sandbox, grants, Pi-home, and network authority unchanged. Do not start a fresh review. Without a token, keep report-only failure handling. Never fabricate or infer a token.
- Never print copied Pi credentials, the isolated Pi home, proxy credentials, or the full process environment.
