---
name: pioneer
description: Delegate a code review from a coding agent to the locally installed Pi coding agent. Use when the user asks Pioneer, Pi, another configured model, or an independent model to review code, a repository, a diff, or an implementation.
license: UEL-1.0
---

# Pioneer

Use the `pioneer` CLI to run an independent review through the operator's existing Pi installation and configured providers. Preserve the CLI's native-session recovery behavior unless the caller explicitly chooses `--no-resume`.

## Preconditions

1. Run the `pioneer` controller outside any enclosing agent sandbox. It must reach the operator's Pi configuration and configured model provider. This does **not** weaken Pioneer: it still launches the Pi review actor in its own native sandbox.
2. Confirm `pioneer` and `pi` are available on `PATH`.
3. On macOS or Linux, run `pioneer doctor` before the first review in a session.
   - For an ordinary readiness failure, stop and present its instructions.
   - If `PIONEER_OUTER_SANDBOX_REQUIRED`, `PI_CONFIG_HIDDEN_BY_SANDBOX`, or `PI_MODELS_CONFIG_INVALID` is present, explain that the outer sandbox may be preventing Pi configuration access or Pi's required lock-file creation. Request explicit approval to rerun `doctor` and the review in an escalated or unsandboxed terminal before changing Pi configuration. Do not read any Pi configuration file. Pioneer still applies its own native sandbox to the Pi review actor.
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

`--git` may be repeated. Accepted values are `working-tree`, `staged`, `untracked`, `commit:REF`, and `range:FROM...TO` or `range:FROM..TO`. Pioneer collects that Git context in the controller on every platform; do not assume Pi can run Git on macOS or Windows. GitHub pull-request numbers and URLs are not Git targets—ask for a local `--git` value instead. For a source-only review, omit `--git` and use a scope such as `Review the implementation under src for correctness, security, and regressions.`

Only include `--model` or `--thinking` when requested. A requested thinking level is binding: include the exact `--thinking <level>` argument in the review command and do not silently omit or substitute it. Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Reviews persist a private controller-owned report by default. Preserve stderr and the always-emitted `[PIONEER_REPORT] ABSOLUTE_PATH` marker, as well as `[PIONEER_WORK_LOG] ABSOLUTE_PATH`; `ReviewResult.reportPath` is the API equivalent. The report marker is emitted after Pioneer exclusively creates a private file containing an in-progress, controller-instance-bound ownership marker; do not treat that reservation marker as a completed report. `--report` selects a different create-only controller target. Use `--no-resume` only when the caller explicitly wants the privacy opt-out and ephemeral Pi launch; that mode does not create or prune resume storage.

Use repeated grants when the review needs more context:

```bash
--allow-read /absolute/reference/path
--allow-write /absolute/output/path
```

The source and `--allow-read` directories remain read-only. `--allow-write` is exceptional and is not required for a final review report: use `--report /absolute/path/report.md` instead. Pioneer writes that report through its exclusively owned controller reservation only after the review succeeds; Pi never receives write access to it.

Pioneer always creates a real-time JSONL work log and immediately prints its exact path to stderr as `[PIONEER_WORK_LOG] ABSOLUTE_PATH`. Preserve that line. Use `--work-log /absolute/new-file.jsonl` only when the caller requests a particular create-only target; the path must not contain control characters. Otherwise use the platform default. Default logs are private to the current user. Windows custom targets inherit their parent directory ACL, which Pioneer cannot validate, so use the default unless the caller identifies a parent already private to the current user. While a terminal session remains nonterminal, tail or inspect that file when status is needed. Five-second heartbeats and the last sanitized Pi event distinguish active, silent, retrying, tool-running, settled, and terminated states without exposing prompt or model/tool content.

Networking defaults to `full`, which permits public, LAN, and loopback destinations through the authenticated proxy. Use `--network public` when LAN access is unnecessary. Do not use `--network none`: a Pioneer review requires Pi to reach its configured model provider, so Pioneer rejects it before launch. Start a new review with `--network public` instead.

Use `--pi-home /absolute/path` only when the caller provides a prepared Pi agent directory. The directory is copied into the isolated run; it is not mounted in place.

## Windows

Windows review execution is not enforceably sandboxed. Never add `--allow-unsandboxed-windows` silently. Explain that source immutability is instruction-only and obtain the user's explicit approval before proceeding. Strict eval runs are unsupported on Windows.

## Presenting results

- Treat a review as transport-successful only when the command's exit status is zero and stdout contains a non-empty report. This is not a semantic verdict: a genuine no-findings result must still be a non-empty report that says so.
- Preserve the command's exit status, stdout, and stderr in any shell or tool wrapper. Do not reduce the result to stdout alone. A capture such as `{"output":""}` is insufficient evidence of either success or failure.
- Treat `[PIONEER_WORK_LOG] ABSOLUTE_PATH` as an informational stderr marker, not a failure. Preserve the path so the caller can inspect live progress and diagnose a hang.
- Treat `[PIONEER_REPORT] ABSOLUTE_PATH` as an informational stderr marker, not a failure. Preserve the path, but do not read it as a completed report until the command reaches a terminal result; Pioneer may still be publishing through its protected reservation. On transport success the path contains the private durable report.
- If a terminal tool returns a session ID without an exit code, the review is still running. Preserve that session ID and poll it until a terminal result includes an exit code; do not report the outer orchestration cell as the review result.
- Pioneer disables Pi extension discovery for reviews and enables only Pi's built-in inspection tools; `write` and `edit` are excluded, while the native sandbox keeps the source read-only. Do not assume subagents, MCP, or any other optional extension is installed.
- Pioneer receives Pi events over process pipes. It does not use `fs.watch`, polling, or a `subagent-results` directory, so watcher fallback messages come from the calling agent runtime and cannot persist or deliver a Pioneer report.
- Preserve concrete findings, file paths, line references, and severity from Pi's report.
- If Pioneer exits with `[REVIEW_REPORT_WRITE_FAILED]`, preserve and present the non-empty stdout Markdown report together with the persistence diagnostic; Pi's review completed, but the requested durable copy did not.
- If Pioneer exits with `[REVIEW_WORK_LOG_CREATE_FAILED]` or `[REVIEW_WORK_LOG_WRITE_FAILED]`, report it as terminal. Pioneer intentionally stops rather than continue a review that cannot be observed in real time, including after the bounded log writes `work_log_truncated`. If stdout still contains a verified report after a close-time work-log failure, preserve and present that report together with the diagnostic.
- Clearly distinguish Pi's findings from your own analysis.
- If the command fails, report the actionable error instead of retrying with a different model, weaker Pioneer sandbox, or broader path grant. The one exception is the explicit outer-terminal access error above, which requires user-approved terminal escalation and does not weaken Pioneer's sandbox.
- If stderr contains both `REVIEW_RPC_OUTPUT_LIMIT` and `[PIONEER_REVIEW_RESUME] TOKEN`, run exactly `pioneer review --resume TOKEN` with only timeout, bounded RPC output, controller-owned report/work-log paths, and a newly explicit Windows acknowledgement as applicable. Do not replace it with a fresh review or change model, thinking, sandbox, grants, Pi-home, or network authority. A tokenless failure retains the existing report-only behavior; never fabricate or infer a resume token.
- Never print copied Pi credentials, the isolated Pi home, proxy credentials, or the full process environment.
