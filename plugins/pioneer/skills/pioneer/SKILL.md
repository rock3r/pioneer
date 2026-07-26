---
name: pioneer
description: Delegate a code review from Codex or Claude Code to the locally installed Pi coding agent. Use when the user asks Pioneer, Pi, another configured model, or an independent model to review code, a repository, a diff, or an implementation.
---

# Pioneer

Use the `pioneer` CLI to run an independent review through the operator's existing Pi installation and configured providers.

## Preconditions

1. Confirm `pioneer` and `pi` are available on `PATH`.
2. On macOS or Linux, run `pioneer doctor` before the first review in a session.
   - For an ordinary readiness failure, stop and present its instructions.
   - If diagnostic `PI_CONFIG_HIDDEN_BY_SANDBOX` is present, explain that the calling agent's outer sandbox is hiding Pi's configuration or made the metadata check inconclusive. Request explicit approval to rerun `doctor` and the review in an escalated or unsandboxed terminal. Do not read any Pi configuration file. Pioneer still applies its own native sandbox to the Pi review actor.
   - For other diagnostic IDs, stop and present their actionable prose. Do not infer a different failure from wording.
3. On Windows, do not use `doctor` as a review readiness check because strict eval isolation is unsupported. Run `pi --version` and `pi --offline --no-approve --no-extensions --list-models` instead.
4. If the user requested a model, preserve the exact name. Let Pioneer reject unavailable or ambiguous names and show the configured qualified model list.

## Review command

Run from the repository being reviewed:

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review the current changes for correctness, security, and regressions. Report concrete findings with file and line references." \
  --model provider/model \
  --thinking high
```

Only include `--model` or `--thinking` when requested. A requested thinking level is binding: include the exact `--thinking <level>` argument in the review command and do not silently omit or substitute it. Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Use repeated grants when the review needs more context:

```bash
--allow-read /absolute/reference/path
--allow-write /absolute/output/path
```

The source and `--allow-read` directories remain read-only. `--allow-write` is exceptional and is not required for a final review report: use `--report /absolute/path/report.md` instead. Pioneer writes that report atomically from the controller only after the review succeeds; Pi never receives write access to it.

Networking defaults to `full`, which permits public, LAN, and loopback destinations through the authenticated proxy. Use `--network public` when LAN access is unnecessary, or `--network none` for an offline review.

Use `--pi-home /absolute/path` only when the caller provides a prepared Pi agent directory. The directory is copied into the isolated run; it is not mounted in place.

## Windows

Windows review execution is not enforceably sandboxed. Never add `--allow-unsandboxed-windows` silently. Explain that source immutability is instruction-only and obtain the user's explicit approval before proceeding. Strict eval runs are unsupported on Windows.

## Presenting results

- Treat a review as transport-successful only when the command's exit status is zero and stdout contains a non-empty report. This is not a semantic verdict: a genuine no-findings result must still be a non-empty report that says so.
- Preserve the command's exit status, stdout, and stderr in any shell or tool wrapper. Do not reduce the result to stdout alone. A capture such as `{"output":""}` is insufficient evidence of either success or failure.
- If a terminal tool returns a session ID without an exit code, the review is still running. Preserve that session ID and poll it until a terminal result includes an exit code; do not report the outer orchestration cell as the review result.
- Pioneer disables Pi extension discovery for reviews and enables only Pi's built-in inspection tools; `write` and `edit` are excluded, while the native sandbox keeps the source read-only. Do not assume subagents, MCP, or any other optional extension is installed.
- Pioneer receives Pi events over process pipes. It does not use `fs.watch`, polling, or a `subagent-results` directory, so watcher fallback messages come from the calling agent runtime and cannot persist or deliver a Pioneer report.
- Preserve concrete findings, file paths, line references, and severity from Pi's report.
- Clearly distinguish Pi's findings from your own analysis.
- If the command fails, report the actionable error instead of retrying with a different model, weaker Pioneer sandbox, or broader path grant. The one exception is the explicit outer-terminal access error above, which requires user-approved terminal escalation and does not weaken Pioneer's sandbox.
- Never print copied Pi credentials, the isolated Pi home, proxy credentials, or the full process environment.
