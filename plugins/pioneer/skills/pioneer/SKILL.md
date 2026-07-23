---
name: pioneer
description: Delegate a code review from Codex or Claude Code to the locally installed Pi coding agent. Use when the user asks Pioneer, Pi, another configured model, or an independent model to review code, a repository, a diff, or an implementation.
---

# Pioneer

Use the `pioneer` CLI to run an independent review through the operator's existing Pi installation and configured providers.

## Preconditions

1. Confirm `pioneer`, `pioneer-eval`, and `pi` are available on `PATH`.
2. On macOS or Linux, run `pioneer-eval doctor` before the first review in a session.
   - For an ordinary readiness failure, stop and present its instructions.
   - If diagnostic `PI_CONFIG_HIDDEN_BY_SANDBOX` is present, explain that the calling agent's outer sandbox is hiding Pi's configuration or made the metadata check inconclusive. Request explicit approval to rerun `doctor` and the review in an escalated or unsandboxed terminal. Do not read any Pi configuration file. Pioneer still applies its own native sandbox to the Pi review actor.
   - For other diagnostic IDs, stop and present their actionable prose. Do not infer a different failure from wording.
3. On Windows, do not use `doctor` as a review readiness check because strict eval isolation is unsupported. Run `pi --version` and `pi --offline --no-approve --list-models` instead.
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

The source and `--allow-read` directories remain read-only. `--allow-write` is exceptional: use it only when the user explicitly needs a persistent report or generated artifact. Pi always receives a private writable scratch directory automatically.

Networking defaults to `full`, which permits public, LAN, and loopback destinations through the authenticated proxy. Use `--network public` when LAN access is unnecessary, or `--network none` for an offline review.

Use `--pi-home /absolute/path` only when the caller provides a prepared Pi agent directory. The directory is copied into the isolated run; it is not mounted in place.

## Windows

Windows review execution is not enforceably sandboxed. Never add `--allow-unsandboxed-windows` silently. Explain that source immutability is instruction-only and obtain the user's explicit approval before proceeding. Strict eval runs are unsupported on Windows.

## Presenting results

- Preserve concrete findings, file paths, line references, and severity from Pi's report.
- Clearly distinguish Pi's findings from your own analysis.
- If the command fails, report the actionable error instead of retrying with a different model, weaker Pioneer sandbox, or broader path grant. The one exception is the explicit outer-terminal access error above, which requires user-approved terminal escalation and does not weaken Pioneer's sandbox.
- Never print copied Pi credentials, the isolated Pi home, proxy credentials, or the full process environment.
