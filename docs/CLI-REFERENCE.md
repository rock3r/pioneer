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
  [--pi-home-include RELATIVE_PATH]...
  [--allow-read DIR]...
  [--allow-write DIR]...
  [--report FILE]
  [--work-log FILE]
  [--network full|public|none]
  [--timeout-ms N]
  [--max-rpc-output-mb N]
  [--no-resume]
  [--allow-unsandboxed-windows]

pioneer review --resume TOKEN
  [--timeout-ms N] [--max-rpc-output-mb N] [--report FILE] [--work-log FILE]
  [--allow-unsandboxed-windows]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--source DIR` | required | Repository or source directory, mounted read-only on macOS/Linux |
| `--prompt TEXT` | required | Exact review request sent after the safety preamble |
| `--model NAME` | Pi default | Configured qualified model, unique model ID, or model with `:thinking` suffix |
| `--thinking LEVEL` | model/Pi default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `--pi-home DIR` | `PI_CODING_AGENT_DIR` or `~/.pi/agent` | Source Pi agent directory to copy into the run |
| `--pi-home-include RELATIVE_PATH` | none | Review-only, repeatable exact path relative to the selected Pi home; may select otherwise skipped content but not hard exclusions |
| `--allow-read DIR` | none | Additional read-only directory; repeatable |
| `--allow-write DIR` | none | Additional writable directory; repeatable and forbidden from overlapping read grants |
| `--report FILE` | private default | Absolute controller-owned output path for the final report; must not exist and must not be visible to the review actor |
| `--work-log FILE` | platform log directory | Absolute controller-owned create-only JSONL path; must not exist, contain control characters, or be visible to the review actor |
| `--network MODE` | `full` | Proxy destination policy |
| `--timeout-ms N` | `900000` | Positive integer review timeout |
| `--max-rpc-output-mb N` | `20` | Integral cumulative Pi RPC stdout bound from 1 through 64 MiB |
| `--no-resume` | false | Explicitly disables private native-session retention for this new review |
| `--allow-unsandboxed-windows` | false | Required acknowledgement for instruction-only Windows reviews |

Exit status is zero only when Pi settles with a non-empty report. The report is written to stdout and atomically persisted to a private default report directory unless `--report` selects another target. Pioneer exclusively creates a private file containing a random ownership marker bound to the controller's OS process-start identity and a randomly named controller-owned sibling reservation link before emitting `[PIONEER_REPORT] ABSOLUTE_PATH` on stderr, then atomically replaces its own reservation with the verified report. An unsuccessful run removes only the reservation it still owns; later retention reclaims abandoned reservation siblings after controller exit. Cleanup of the now-unneeded sibling after durable publication is best effort and cannot turn a delivered report into failure. If persistence fails, stdout still contains the verified report, the recoverable session is retained when available, and Pioneer exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`; diagnostics and warnings use stderr.

The default cumulative RPC stdout bound is 20 MiB; `--max-rpc-output-mb` accepts only integral values from 1 through 64. Overflow terminates the process tree and reports `[REVIEW_RPC_OUTPUT_LIMIT]` with byte metadata in the work log. High-volume delta metadata is batched after the first 1,000 events in five-second type/subtype windows, so the 16 MiB work-log cap remains an independent fail-closed bound.

New reviews retain a private native Pi session after a strict non-success only when process-tree containment is proven and the opaque session tree is a regular candidate within the 32 MiB/5,000-entry committed-attempt cap. This leaves room for the next crash-safe copy inside the aggregate 64 MiB/10,000-entry archive cap. Pioneer emits `[PIONEER_REVIEW_RESUME] TOKEN`; resume accepts only the immutable stored source, grants, prompt scope, model, thinking, Pi-home, and network policy. It may change only timeout, bounded RPC output, and controller-owned output paths. A resume always requires a fresh Windows acknowledgement. If both `[REVIEW_RPC_OUTPUT_LIMIT]` and a resume token appear, clients must run exactly `pioneer review --resume TOKEN`; a tokenless failure is not resumable. `--no-resume` runs neither create nor prune the private resume store.

Immediately after opening the controller-owned work log, Pioneer prints `[PIONEER_WORK_LOG] ABSOLUTE_PATH` to stderr. Without `--work-log`, it creates a unique `review-*.jsonl` file in:

- macOS: `~/Library/Logs/Pioneer/reviews/`;
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pioneer/logs/reviews/`;
- Windows: `%LOCALAPPDATA%\Pioneer\Logs\reviews\`.

Each schema-versioned JSONL record is written synchronously before Pioneer continues, so `tail -f` observes it immediately; a dirty-log timer syncs the file to disk within one second even when Pi is silent, and Pioneer syncs again on close. Records include timestamps, elapsed time, run/sequence IDs, controller stages, Pi process state, restricted Pi RPC event metadata, stderr byte activity, retries, tool lifecycle, settlement, termination, and a heartbeat every five seconds while Pi RPC is active. Pi-controlled strings are represented only by allowlisted protocol values, tool-call hashes, booleans, and presence/byte-count metadata. The log deliberately excludes prompt and model-generated text, thinking, tool arguments/output, unrestricted Pi reasons/diagnostics, queue contents, environment values, and credentials. Each auto-created log is capped at 16 MiB; reaching the cap writes `work_log_truncated` and fails the review instead of continuing without observability. Private nonce-backed leases carry an OS process-start identity and are refreshed by a worker thread even if the controller event loop hangs. If suspend/resume or a clock step makes a live lease look old, retention preserves it when its PID and process identity still match; legacy markers and temporarily unverifiable identities receive one renewal interval, but PID liveness alone never protects a current log. Abandoned leases therefore expire after crashes and PID reuse, and both creation-time and close-time retention reclaim expired leases. Retention runs after both default-log creation and lease removal on close, pruning only inactive auto-named files toward the newest 100 total even after a large overlapping batch drains. Both passes complete their bounded critical section synchronously under a private cross-process lock with an atomically published PID, nonce, and OS process-start identity. Windows records a narrow millisecond-scale hashed start-time window to tolerate clock-source rounding without allowing practical PID reuse; Linux uses kernel boot/start ticks, and macOS canonicalizes its OS start time under the C locale and UTC. A suspended owner retains the same process identity, while PID reuse does not; release also verifies the exact owner record before unlinking. A closing log renews its lease until it owns that lock, protects its target, and prefers older last-write times, so concurrently finishing logs cannot delete one another while older completed logs remain. A custom target must be absolute, absent, and have an existing writable non-symlink parent; Pioneer does not rotate custom targets outside its reserved auto-name pattern.

On Windows, a custom target inherits its parent directory ACL because POSIX mode bits do not establish a DACL. Pioneer cannot validate arbitrary Windows ACLs; use the default path unless the custom parent is already private to the current user.

`[REVIEW_WORK_LOG_CREATE_FAILED]` means Pioneer could not establish the requested observability channel, while `[REVIEW_WORK_LOG_WRITE_FAILED]` means real-time flushing failed after creation. Either failure is terminal; Pioneer does not continue an unobservable review.

Transport success is not a semantic review verdict. A no-findings review still returns a non-empty Markdown report. Stable completion failures are `[REVIEW_REPORT_MISSING]` when Pi settles without a report, `[REVIEW_ASSISTANT_FAILED]` when Pi reports a failed or aborted assistant run, `[REVIEW_RPC_INCOMPLETE]` when the RPC process ends before settling, `[REVIEW_PROCESS_FAILED]` when a settled Pi process with a report exits nonzero or by signal, `[REVIEW_PROCESS_CONTAINMENT_FAILED]` when Pioneer cannot prove the process tree stopped after its child exits, `[REVIEW_RESUME_SESSION_INVALID]` for a torn native session, `[REVIEW_RESUME_PI_VERSION_MISMATCH]` for an exact Pi-version mismatch, `[REVIEW_RESUME_ATTEMPT_LIMIT]` when the bounded retry layout is exhausted, `[REVIEW_RESUME_IN_USE]` when another controller still owns the active archive lease, and the work-log failures described above. A containment, retry-layout, or in-use failure is never issued a usable resume token.

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

Review Pi-home snapshots copy only the known root configuration files and `skills/`; unknown root paths and dependency/runtime fluff are skipped. `--pi-home-include` names one existing relative file or directory exactly; use `--pi-home-include=--NAME` for an exact path beginning with `--`. It accepts no glob, negation, or persistent configuration syntax, and paths cannot be absolute, traverse with `..`, or escape the source home. Sessions, logs, `.npm`, `.cache`, `tmp`, `.tmp`, `temp`, and `*.log` paths are hard exclusions, matched case-insensitively on macOS and Windows. Internal symlinks are retained only when their targets are also selected. Review includes are not accepted by eval commands.

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

The output must not exist and its canonical parent must keep it outside the source skill. Pioneer revalidates the created destination before populating it. The command rejects symlinks in the skill, requires `skill_name` to be one portable path component valid on Windows and Unix, including the 255-byte filename limit, parses `evals.json`, and creates controller metadata plus baseline/with-skill actor directories.

## `pioneer eval run`

```text
pioneer eval run --run-dir DIR
  [--pi-home DIR]
  [--runtime-read PATH]...
  [--deny-read-probe PATH]...
  [--timeout-ms N]
  -- COMMAND [ARG ...]
```

The command after `--` is executed as discrete argv in the strict sandbox. The runner first performs mandatory filesystem, environment, and loopback probes. Before creating launch artifacts it validates the executable: bare names use the selected sanitized `PATH`, relative paths are anchored to the run directory, and absolute/symlinked launchers are canonicalized with narrow exact grants. Actor stdout and stderr observed before termination are propagated within a 4 MiB stdout and 64 KiB stderr bound; exit status and terminating signal are also returned.

Eval failures return nonzero. Stable stderr diagnostics are `[EVAL_TIMEOUT]` for timeout, `[EVAL_INTERRUPTED]` for SIGINT/SIGTERM, `[EVAL_SPAWN_FAILED]` for sandbox launch failure, `[EVAL_SHEBANG_RESOLUTION_FAILED]` for a cyclic, excessively deep, or unterminated-overlong `/usr/bin/env` interpreter chain, `[EVAL_PROCESS_CONTAINMENT_FAILED]` when inherited pipes prevent proving the process tree stopped, and `[EVAL_OUTPUT_LIMIT]` when the output bound is exceeded. These diagnostics do not print the actor environment, Pi configuration, or authenticated proxy URL.

When the actor executable is Pi, fast-start flags are added automatically and skills are disabled. The writable run directory and read-only runtime paths must all be narrow and non-overlapping. Writable protected-system roots and their descendants, plus broad filesystem, sensitive-configuration, temporary, variable-data, and home roots, are rejected after canonicalization; narrowly selected read-only system runtimes and disposable temporary descendants remain supported. Eval networking is always public-only.

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
