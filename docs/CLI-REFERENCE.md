# CLI reference

## Executables

After building and linking the source checkout, one executable is available:

- `pioneer` — review readiness, model discovery, synchronous code reviews, and isolated eval workflows.

The repository npm scripts build first:

```bash
npm run pioneer -- review ...
npm run pioneer -- doctor
```

## Version output

The CLI prints the installed Pioneer package version without probing Pi:

```bash
pioneer --version
```

## Package updates

Normal Pioneer commands begin a best-effort npm update check without delaying command startup. The check runs at most once every 24 hours, caches the newest published version, and prints an update notice to stderr only after the requested command finishes. A failed background check is silent and never changes that command's exit status.

Force a check now:

```bash
pioneer check-update
```

To update a global npm installation, Pioneer first forces the same check. When a newer version is available, it asks whether to print that release's changelog and whether to install it. The installation is delegated to npm as `npm install --global @rock3r/pioneer@VERSION`.

```bash
pioneer update
pioneer update --changelog --yes
```

`--changelog` answers yes to the changelog prompt; `--yes` (or `-y`) answers yes to the installation prompt. Use both flags in non-interactive automation.

## `pioneer review`

```text
pioneer review --source DIR --prompt TEXT
  [--model PROVIDER/MODEL]
  [--thinking LEVEL]
  [--pi-home DIR]
  [--allow-read DIR]...
  [--allow-write DIR]...
  [--report FILE]
  [--work-log FILE]
  [--network full|public|none]
  [--timeout-ms N]
  [--allow-unsandboxed-windows]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--source DIR` | required | Repository or source directory, mounted read-only on macOS/Linux |
| `--prompt TEXT` | required | Exact review request sent after the safety preamble |
| `--model NAME` | Pi default | Configured qualified model, unique model ID, or model with `:thinking` suffix |
| `--thinking LEVEL` | model/Pi default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `--pi-home DIR` | `PI_CODING_AGENT_DIR` or `~/.pi/agent` | Source Pi agent directory to copy into the run |
| `--allow-read DIR` | none | Additional read-only directory; repeatable |
| `--allow-write DIR` | none | Additional writable directory; repeatable and forbidden from overlapping read grants |
| `--report FILE` | none | Absolute controller-owned output path for the final report; must not exist and must not be visible to the review actor |
| `--work-log FILE` | platform log directory | Absolute controller-owned create-only JSONL path; must not exist and must not be visible to the review actor |
| `--network MODE` | `full` | Proxy destination policy |
| `--timeout-ms N` | `900000` | Positive integer review timeout |
| `--allow-unsandboxed-windows` | false | Required acknowledgement for instruction-only Windows reviews |

Exit status is zero only when Pi settles with a non-empty report. The report is written to stdout. When `--report` is set, Pioneer additionally creates that file atomically only after the same success contract passes. If persistence fails, stdout still contains the verified report but Pioneer exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`; diagnostics and warnings use stderr.

Immediately after opening the controller-owned work log, Pioneer prints `[PIONEER_WORK_LOG] ABSOLUTE_PATH` to stderr. Without `--work-log`, it creates a unique `review-*.jsonl` file in:

- macOS: `~/Library/Logs/Pioneer/reviews/`;
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pioneer/logs/reviews/`;
- Windows: `%LOCALAPPDATA%\Pioneer\Logs\reviews\`.

Each schema-versioned JSONL record is written synchronously before Pioneer continues, so `tail -f` observes it immediately; a dirty-log timer syncs the file to disk within one second even when Pi is silent, and Pioneer syncs again on close. Records include timestamps, elapsed time, run/sequence IDs, controller stages, Pi process state, restricted Pi RPC event metadata, stderr byte activity, retries, tool lifecycle, settlement, termination, and a heartbeat every five seconds while Pi RPC is active. Pi-controlled strings are represented only by allowlisted protocol values, tool-call hashes, booleans, and presence/byte-count metadata. The log deliberately excludes prompt and model-generated text, thinking, tool arguments/output, unrestricted Pi reasons/diagnostics, queue contents, environment values, and credentials. Each auto-created log is capped at 16 MiB. Private nonce-backed leases are refreshed by a worker thread even if the controller event loop hangs. If suspend/resume or a clock step makes a live lease look old, retention gives its live PID one renewal interval to prove nonce ownership; PID liveness alone never protects the log. Abandoned leases therefore expire after crashes and PID reuse, then retention prunes only inactive auto-named files toward the newest 100 total. A custom target must be absolute, absent, and have an existing writable non-symlink parent; Pioneer does not rotate custom targets outside its reserved auto-name pattern.

`[REVIEW_WORK_LOG_CREATE_FAILED]` means Pioneer could not establish the requested observability channel, while `[REVIEW_WORK_LOG_WRITE_FAILED]` means real-time flushing failed after creation. Either failure is terminal; Pioneer does not continue an unobservable review.

Transport success is not a semantic review verdict. A no-findings review still returns a non-empty Markdown report. Stable completion failures are `[REVIEW_REPORT_MISSING]` when Pi settles without a report, `[REVIEW_ASSISTANT_FAILED]` when Pi reports a failed or aborted assistant run, `[REVIEW_RPC_INCOMPLETE]` when the RPC process ends before settling, `[REVIEW_PROCESS_FAILED]` when a settled Pi process with a report exits nonzero or by signal, `[REVIEW_PROCESS_CONTAINMENT_FAILED]` when Pioneer cannot prove the process tree stopped after its child exits, and the work-log failures described above.

## `pioneer models`

Lists the configured models visible to the same offline Pi readiness probe used by reviews:

```text
pioneer models [--pi-home DIR] [--json]
```

Human output contains one sorted, qualified `provider/model` name per line. `--json` emits a schema-versioned catalog:

```json
{
  "schemaVersion": 1,
  "piVersion": "0.81.1",
  "models": [
    {
      "provider": "openrouter",
      "id": "x-ai/grok-4.5",
      "qualifiedName": "openrouter/x-ai/grok-4.5"
    }
  ]
}
```

`--pi-home` selects an alternative Pi agent directory without copying it. The command fails nonzero with the same readiness diagnostic used by reviews. In particular, Pioneer refuses to return a partial catalog when Pi reports that `models.json` is invalid.

## `pioneer doctor`

Checks Pi, configured models, and strict platform sandbox dependencies. It prints schema-versioned JSON and exits nonzero when unsupported or unready. Human-readable entries in `errors` start with a stable diagnostic ID. Machine consumers should branch on `diagnostics[].id`, not prose.

```json
{
  "schemaVersion": 1,
  "platform": "darwin",
  "supported": false,
  "pi": { "version": "0.81.1", "modelCount": 0 },
  "warnings": [],
  "errors": ["[PI_NO_MODELS] Pi is installed but has no available configured models. ..."],
  "diagnostics": [
    {
      "id": "PI_NO_MODELS",
      "severity": "error",
      "message": "Pi is installed but has no available configured models. ..."
    }
  ]
}
```

The v1 diagnostic IDs are listed below. Warning diagnostics use `severity: "warning"` and do not make `supported` false:

| ID | Meaning |
| --- | --- |
| `PI_VERSION_TOO_OLD` | Pi is below the minimum supported version |
| `PI_VERSION_UNRECOGNIZED` | `pi --version` did not return SemVer |
| `PI_VERSION_UNTESTED` | Pi is newer than the tested maximum; execution continues with a warning |
| `PI_CLI_INCOMPATIBLE` | Pi reports an in-range version but lacks a required project-trust option |
| `PI_NOT_FOUND` | Pi is absent from `PATH` |
| `PI_PROBE_FAILED` | Pi failed or timed out during readiness probing |
| `PI_NO_MODELS` | Pi is visible but has no configured models |
| `PI_MODELS_CONFIG_INVALID` | Pi reported that `models.json` could not be loaded; partial catalogs are rejected |
| `PI_CONFIG_HIDDEN_BY_SANDBOX` | An outer agent sandbox hides Pi configuration or makes access metadata inconclusive |
| `PI_MODEL_LIST_UNRECOGNIZED` | Pi returned an unsupported model-list format |
| `EVAL_PLATFORM_UNSUPPORTED` | Strict eval isolation has no backend for the platform |
| `WINDOWS_STRICT_ISOLATION_UNAVAILABLE` | Windows strict eval execution is intentionally unavailable |
| `LINUX_USER_NAMESPACE_RESTRICTED` | Ubuntu requires the narrow AppArmor-confined Bubblewrap install |
| `BUBBLEWRAP_NOT_FOUND` | Bubblewrap is not installed |
| `UNCLASSIFIED_ERROR` | A legacy or unexpected error lacked a stable prefix |

When Pi reports zero models, `doctor` checks only whether the terminal may access Pi configuration metadata. It never reads configuration contents. If access is denied, the error says the command must be rerun with approved outer-terminal escalation; otherwise it gives normal Pi `/login` guidance.

Since some policy sandboxes make metadata access look successful while hiding file contents, recognized sandbox environment indicators also select the conservative escalation diagnostic. Set `PIONEER_OUTER_SANDBOX=1` to identify an otherwise unknown outer sandbox. Pioneer reports the variable name but not its value.

```bash
pioneer doctor
```

Windows always reports strict eval execution as unsupported.

## `pioneer eval prepare`

```text
pioneer eval prepare --skill DIR --evals FILE --output DIR
```

The output must not exist and must be outside the source skill. The command rejects symlinks in the skill, parses `evals.json`, and creates controller metadata plus baseline/with-skill actor directories.

## `pioneer eval run`

```text
pioneer eval run --run-dir DIR
  [--pi-home DIR]
  [--runtime-read PATH]...
  [--deny-read-probe PATH]...
  [--timeout-ms N]
  -- COMMAND [ARG ...]
```

The command after `--` is executed as discrete argv in the strict sandbox. The runner first performs mandatory filesystem, environment, and loopback probes. Actor stdout, stderr, exit status, and terminating signal are propagated.

When the actor executable is Pi, fast-start flags are added automatically and skills are disabled. Runtime read paths must be narrow and are mounted read-only. Eval networking is always public-only.

## `pioneer eval install-linux`

On Ubuntu systems with restricted unprivileged user namespaces:

```bash
npm run build
sudo node dist/review-cli.js eval install-linux
```

The command must run as root. It installs a root-owned copy of `/usr/bin/bwrap` at `/usr/local/libexec/pioneer/bwrap` and loads one AppArmor profile granting `userns` only to that executable. It does not change a global sysctl.

## Environment

| Variable | Use |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Selects the source Pi agent directory when `--pi-home` is absent |
| `PATH` | Locates Pi, Node, and the CLI |
| `LANG`, `LC_ALL` | Preserved when present |
| `PIONEER_DEBUG` | Enables limited proxy diagnostics; never enable in routine use |

Run-local `HOME`, `TMPDIR`, proxy variables, `PI_OFFLINE`, and `PI_TELEMETRY` are set by the controller. Arbitrary host environment variables are not passed into sandboxed actors.
