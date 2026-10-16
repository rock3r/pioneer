# CLI reference

## Executables

Build and link the source checkout to use the executable:

- `pioneer` — review readiness, model discovery, synchronous code reviews, and isolated eval workflows.

Repository npm scripts build before running Pioneer:

```bash
npm run pioneer -- review ...
npm run pioneer -- doctor
```

## Version output

Print the installed Pioneer version without probing Pi:

```bash
pioneer --version
```

## Package updates

Normal commands start a background npm update check without waiting for it. Pioneer checks at most once every 24 hours and caches the newest published version. Any update notice goes to stderr after the command finishes. A failed check prints nothing and leaves the command's exit status unchanged.

Force a check now:

```bash
pioneer check-update
```

For global npm updates, Pioneer forces that check first. If a newer version exists, it asks whether to print its changelog and install it. It runs `npm install --global @rock3r/pioneer@VERSION` to install.

```bash
pioneer update
pioneer update --changelog --yes
```

`--yes` or `-y` installs without prompts or changelog output. `--changelog` prints the changelog without asking. Combine `--changelog` and `--yes` to print it before a non-interactive install.

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
  [--network full|public]
  [--git TARGET]...
  [--timeout-ms N]
  [--max-rpc-output-mb N]
  [--no-resume]
  [--no-extensions]
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
| `--git TARGET` | inferred for Git-target prompts | Repeatable controller Git inspection target: `working-tree`, `staged`, `untracked`, `commit:REF`, or `range:FROM...TO` / `range:FROM..TO`. Incompatible with `--resume`. |
| `--report FILE` | private default | Absolute controller-owned output path for the final report; must not exist, must not be visible to the review actor, and on macOS and Linux every folder above it must be owned by you or root and not writable by other users unless sticky |
| `--work-log FILE` | platform log directory | Absolute controller-owned create-only JSONL path; must not exist, contain control characters, or be visible to the review actor |
| `--network MODE` | `full` | Proxy destination policy |
| `--timeout-ms N` | `900000` | Positive integer review timeout |
| `--max-rpc-output-mb N` | `20` | Integral cumulative Pi RPC stdout bound from 1 through 64 MiB |
| `--no-extensions` | false | Explicitly use built-in providers only; also available for models and doctor |
| `--no-resume` | false | Explicitly disables private native-session retention for this new review |
| `--allow-unsandboxed-windows` | false | Required acknowledgement for instruction-only Windows reviews |

Exit zero requires Pi to settle with a non-empty report. Pioneer prints the report to stdout and saves it privately. `--report` changes the default save target.

Before printing `[PIONEER_REPORT] ABSOLUTE_PATH` to stderr, Pioneer exclusively creates a private reservation file and a randomly named controller-owned sibling link. A random ownership marker binds the file to the controller's OS process-start identity. Pioneer writes verified report bytes through that inode. A separate random publication lease prevents retention from pruning it during writing.

If writing fails, Pioneer restores the marker. If target identity changes, it fails without overwriting or deleting the replacement. Failed runs remove only reservations they still own. After controller exit, retention reclaims abandoned reservation/publication siblings and inactive post-publication hard links. Cleanup after durable publication is best effort and cannot invalidate a delivered report.

If saving fails, stdout still contains the verified report. Pioneer retains a recoverable session when available and exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`. Diagnostics and warnings go to stderr.

Pioneer rejects `--network none` before Pi starts with `[REVIEW_NETWORK_DISABLED]`. The actor needs access to its model provider. Start a new review with `--network public`. Use `--network full` only for required LAN or loopback access.

RPC stdout has a cumulative 20 MiB default bound. `--max-rpc-output-mb` accepts integral values from 1 through 64. Overflow terminates the process tree with `[REVIEW_RPC_OUTPUT_LIMIT]` and logs byte metadata. After the first 1,000 high-volume delta events, Pioneer batches metadata by type/subtype in five-second windows. The independent 16 MiB work-log cap still fails closed.

After strict failure, new reviews retain a private native Pi session only when Pioneer proves process-tree containment and finds a regular opaque session tree. A committed attempt cannot exceed 32 MiB/5,000 entries. This reserves room for the next crash-safe copy within the total archive cap of 64 MiB/10,000 entries.

Pioneer prints `[PIONEER_REVIEW_RESUME] TOKEN`. Resume keeps the stored source, grants, prompt scope, model, thinking, Pi-home, Git targets, and network policy unchanged. Only timeout, bounded RPC output, and controller-owned output paths can change. Windows always requires fresh acknowledgement.

Earlier archives using `--network none` fail with `[REVIEW_NETWORK_DISABLED]`. Start a new review with `--network public` or `--network full`. If `[REVIEW_RPC_OUTPUT_LIMIT]` and a resume token both appear, run exactly `pioneer review --resume TOKEN`. Tokenless failures cannot resume. `--no-resume` neither creates nor prunes the private resume store.

Pioneer prints `[PIONEER_WORK_LOG] ABSOLUTE_PATH` to stderr immediately after opening the controller-owned log. Without `--work-log`, it creates a unique `review-*.jsonl` file in:

- macOS: `~/Library/Logs/Pioneer/reviews/`;
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pioneer/logs/reviews/`;
- Windows: `%LOCALAPPDATA%\Pioneer\Logs\reviews\`.

Pioneer writes each schema-versioned JSONL record synchronously before continuing, so `tail -f` sees it immediately. A dirty-log timer syncs to disk within one second, even while Pi is silent. Pioneer syncs again on close.

Records include timestamps, elapsed time, run/sequence IDs, controller stages, Pi process state, restricted RPC metadata, stderr byte activity, retries, and tool lifecycle. They also cover settlement, termination, and a five-second heartbeat while Pi RPC is active.

Pi-controlled strings appear only as allowlisted protocol values, tool-call hashes, booleans, or presence/byte-count metadata. Unknown event types use `unrecognized`. Known unsummarized Pi session event names use `unrecognizedEventType`; others use a short hash in `unrecognizedEventTypeHash`.

Logs exclude prompts, model text, thinking, tool arguments/output, unrestricted Pi reasons/diagnostics, queue contents, environment values, and credentials. Auto-created logs have a 16 MiB cap. Reaching it writes `work_log_truncated` and fails the review.

Private leases carry a nonce and OS process-start identity. A worker thread refreshes them even if the controller event loop hangs. Retention preserves an old-looking lease after suspend/resume or a clock step if PID and process identity still match. Legacy markers and temporarily unverifiable identities get one renewal interval. PID liveness alone never protects a current log.

Abandoned leases expire after crashes or PID reuse. Retention reclaims expired leases after default-log creation and lease removal on close. It prunes only inactive auto-named files toward the newest 100 total, including after large overlapping batches finish.

Both retention passes run bounded synchronous critical sections under a private cross-process lock. Lock publication atomically records PID, nonce, and OS process-start identity. Windows uses a narrow millisecond-scale hashed start-time window to allow clock-source rounding without practical PID reuse. Linux uses kernel boot/start ticks. macOS canonicalizes OS start time with the C locale and UTC.

Suspension preserves process identity; PID reuse changes it. Release checks the exact owner record before unlinking. Closing logs renew their leases until they own the lock and protect their targets. Retention prefers older last-write times, so concurrently finishing logs cannot delete each other while older completed logs remain.

Custom targets must be absolute and absent, with an existing writable non-symlink parent. Pioneer does not rotate custom targets outside its reserved auto-name pattern.

Windows custom targets inherit the parent directory ACL. POSIX mode bits do not establish a DACL. Pioneer cannot validate arbitrary Windows ACLs. Use the default path unless the custom parent is already private to you.

`[REVIEW_WORK_LOG_CREATE_FAILED]` means Pioneer could not create the requested log. `[REVIEW_WORK_LOG_WRITE_FAILED]` means real-time flushing failed after creation. Either failure stops the review.

Transport success confirms report delivery. The report itself states the review findings. A no-findings review still returns non-empty Markdown. Completion failures use these codes:

- `[REVIEW_REPORT_MISSING]`: Pi settled without a report.
- `[REVIEW_ASSISTANT_FAILED]`: Pi reported a failed or aborted assistant run.
- `[REVIEW_RPC_INCOMPLETE]`: RPC ended before settling.
- `[REVIEW_PROCESS_FAILED]`: Pi settled with a report, then exited nonzero or by signal.
- `[REVIEW_PROCESS_CONTAINMENT_FAILED]`: Pioneer could not prove the tree stopped after child exit.
- `[REVIEW_RESUME_SESSION_INVALID]`: the native session was torn.
- `[REVIEW_RESUME_PI_VERSION_MISMATCH]`: the exact Pi version differed.
- `[REVIEW_RESUME_ATTEMPT_LIMIT]`: the bounded retry layout was exhausted.
- `[REVIEW_RESUME_IN_USE]`: another controller owned the active archive lease.
- The work-log failures above.

Containment, retry-layout, and in-use failures never issue a usable resume token.

## `pioneer models`

List configured models with the review's offline Pi readiness probe:

```text
pioneer models [--pi-home DIR] [--json] [--no-extensions]
```

Human output sorts qualified `provider/model` names, one per line. `--json` prints a schema-versioned catalog:

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

`--pi-home` selects the private configuration and enabled-extension snapshot source. Discovery runs extensions inside the native sandbox; see [Pi extensions](PI-EXTENSIONS.md). Readiness failures return nonzero with the review diagnostic. Invalid `models.json` prevents Pioneer from returning a partial catalog.

Review Pi-home snapshots copy only known root configuration files and `skills/`. They skip unknown root paths and dependency/runtime content. `--pi-home-include` selects one existing relative file or directory by exact path. Use `--pi-home-include=--NAME` for paths starting with `--`.

Includes accept no glob, negation, or persistent configuration syntax. Paths cannot be absolute, use `..`, or escape the source home. Sessions, logs, `.npm`, `.cache`, `tmp`, `.tmp`, `temp`, and `*.log` are hard exclusions, case-insensitively on macOS and Windows. Internal symlinks survive only if their targets are also selected. Eval commands reject review includes.

## `pioneer doctor`

Check Pi, configured models, enabled user extensions, and strict platform sandbox dependencies. `pioneer doctor --no-extensions` checks only built-in providers. Doctor prints schema-versioned JSON and exits nonzero for unsupported or unready setups. Human-readable `errors` start with a stable diagnostic ID. Machine consumers should use `diagnostics[].id`.

```json
{
  "schemaVersion": 1,
  "platform": "darwin",
  "supported": false,
  "pi": { "version": "0.81.1", "modelCount": 0 },
  "warnings": [
    "[PIONEER_OUTER_SANDBOX_REQUIRED] Pioneer must run outside any enclosing agent sandbox so the controller can access Pi configuration and the configured provider. This does not weaken Pioneer's native sandbox for review and eval actors."
  ],
  "errors": ["[PI_CONFIG_HIDDEN_BY_SANDBOX] Pi reported no configured models, but this terminal appears unable to expose Pi configuration. ..."],
  "diagnostics": [
    {
      "id": "PI_CONFIG_HIDDEN_BY_SANDBOX",
      "severity": "error",
      "message": "Pi reported no configured models, but this terminal appears unable to expose Pi configuration. ..."
    },
    {
      "id": "PIONEER_OUTER_SANDBOX_REQUIRED",
      "severity": "warning",
      "message": "Pioneer must run outside any enclosing agent sandbox so the controller can access Pi configuration and the configured provider. This does not weaken Pioneer's native sandbox for review and eval actors."
    }
  ]
}
```

The v1 diagnostic IDs are listed below. Warning diagnostics use `severity: "warning"` and do not make `supported` false:

| ID | Meaning |
| --- | --- |
| `PI_VERSION_TOO_OLD` | Pi is below the minimum supported version |
| `PI_VERSION_UNRECOGNIZED` | `pi --version` did not return SemVer |
| `PI_NO_MCP_VERSION_UNKNOWN` | A tool-restricted Pi actor reached launch without a known Pi version, so Pioneer cannot decide whether `--no-mcp` is required |
| `PI_VERSION_UNTESTED` | Pi is newer than the tested maximum; execution continues with a warning |
| `PI_CLI_INCOMPATIBLE` | Pi reports an in-range version but lacks a required project-trust option |
| `PI_NOT_FOUND` | Pi is absent from `PATH` |
| `PI_PROBE_FAILED` | Pi failed or timed out during readiness probing |
| `PI_NO_MODELS` | Pi is visible but has no configured models |
| `PI_MODELS_CONFIG_INVALID` | Pi reported that `models.json` could not be loaded; partial catalogs are rejected and callers are told to rule out outer-sandbox interference first |
| `PI_CONFIG_HIDDEN_BY_SANDBOX` | An outer agent sandbox hides Pi configuration or makes access metadata inconclusive |
| `PIONEER_OUTER_SANDBOX_REQUIRED` | Doctor saw a Pi catalog or configuration failure and tells callers to launch the Pioneer controller outside an enclosing agent sandbox |
| `PI_MODEL_LIST_UNRECOGNIZED` | Pi returned an unsupported model-list format |
| `EVAL_PLATFORM_UNSUPPORTED` | Strict eval isolation has no backend for the platform |
| `WINDOWS_STRICT_ISOLATION_UNAVAILABLE` | Windows strict eval execution is intentionally unavailable |
| `LINUX_USER_NAMESPACE_RESTRICTED` | Ubuntu requires the narrow AppArmor-confined Bubblewrap install |
| `BUBBLEWRAP_NOT_FOUND` | Bubblewrap is not installed |
| `UNCLASSIFIED_ERROR` | A legacy or unexpected error lacked a stable prefix |

If Pi reports zero models, `doctor` checks terminal access to configuration metadata without reading contents. Denied access produces an error requiring approved outer-terminal escalation. Otherwise, doctor gives normal Pi `/login` guidance.

Some policy sandboxes allow metadata access while hiding contents. Recognized sandbox environment indicators therefore also select the escalation diagnostic. Set `PIONEER_OUTER_SANDBOX=1` for an unknown outer sandbox. Pioneer reports only the variable name, never its value.

```bash
pioneer doctor
```

Windows always reports strict eval execution as unsupported.

## `pioneer eval prepare`

```text
pioneer eval prepare --skill DIR --evals FILE --output DIR [--allow-fixture-name GLOB]...
```

The output must not exist. Its canonical parent must keep it outside the source skill. Pioneer rechecks the created destination before populating it. The command rejects skill symlinks and requires a single Windows/Unix-portable `skill_name` component within 255 bytes. It parses `evals.json` and creates controller metadata and baseline/with-skill actor directories.

Before creating output, prepare checks `files[]` paths for grading cues at camelCase/kebab/snake/dot word boundaries. These words fail with `[EVAL_FIXTURE_LEAK]`: `stale`, `bug`, `defect`, `bad`, `good`, `broken`, `wrong`, `negative`, `positive`, `rough`, `showcase`, `expected`, `fixture`, and `case`.

Joined camelCase/PascalCase words can include `case` and `fixture`: `BadgeCase.kt` and `TestFixture.kt` pass; `Fixture.kt` and `test-fixture.kt` fail. Prepare checks source paths and staged paths under `fixtures/`.

Content checks reject `BUG:`, `TODO:`, or `FIXME` in any case, and bare uppercase `TODO` or `XXX`. Bare lowercase `todo` and `xxx` pass. Markers match whole tokens, so `DEBUG:` does not match `BUG:`. `TODO-list.md` passes because `todo` is not a path term.

Repeat `--allow-fixture-name GLOB` to waive path collisions matching the source path, staged path, or basename. It cannot waive content markers. See [EVALS.md](EVALS.md#fixture-checks).

Each `files[]` entry must resolve to a regular file no larger than 64 MiB. Directories and special files, including FIFOs, fail before output creation. Oversized files fail with `[EVAL_FIXTURE_TOO_LARGE]`. Prepare scans each fixture through one open descriptor, closes it, and records its identity.

Staging reopens and rescans the file while copying. Changed device, inode, size, modification/change time, or permission bits fail with `[EVAL_FIXTURE_CHANGED]`.

Prepare stages files under `fixtures/` in each actor run directory. It rewrites prompt paths to resolve from the actor working directory. `case.json` stores `id`, rewritten `prompt`, original `source_prompt`, `fixtures_dir`, and staged `files`. Ambiguous shared basenames stay unchanged.

The JSON result adds `actorContract` with `caseFile`, `fixturesDir`, `promptField`, and a one-sentence `description`. Pioneer prints that sentence to stderr as `[PIONEER_EVAL_ACTOR_CONTRACT]`.

## `pioneer eval run`

```text
pioneer eval run --run-dir DIR
  [--pi-home DIR]
  [--runtime-read PATH]...
  [--deny-read-probe PATH]...
  [--timeout-ms N]
  [--work-log FILE]
  [--allow-loopback HOST:PORT]...
  [--env NAME=VALUE]...
  [--pi-extension PATH]...
  [--stdout-file FILE]
  [--stderr-file FILE]
  -- COMMAND [ARG ...]
```

Pioneer runs the command after `--` with separate arguments in the strict sandbox. Mandatory filesystem, environment, and loopback probes run first.

Before creating launch artifacts, Pioneer validates the executable. Bare names use the selected sanitized `PATH`. Relative paths resolve from the run directory. Pioneer canonicalizes absolute or symlinked launchers and grants access to their exact paths.

Pioneer returns output seen before termination, up to 4 MiB stdout and 64 KiB stderr, plus exit status and terminating signal. `--stdout-file FILE` and `--stderr-file FILE` stream output to files instead, with a 1 GiB bound per stream. Pioneer prints nothing for a redirected stream. Its diagnostics still go to stderr.

Use file output for large results. For example, `pi --mode json` repeats every image the agent reads as base64.

Each target follows the `--work-log` rules. It must be absolute, absent, free of control characters, and outside every actor-visible grant. Only you or root can change its parent folders. It must differ from the work log and the other output file.

Pioneer creates mode `0600` files just before actor launch. Earlier failures leave no file. A rejected target produces `[EVAL_OUTPUT_FILE_CREATE_FAILED]`. If stdout creation succeeds but stderr creation fails, the diagnostic names the empty stdout file left behind. Remove it before retrying. Pioneer avoids path-based deletion because another process could replace it. A write failure stops the run with `[EVAL_OUTPUT_WRITE_FAILED]`.

Before launch, Pioneer prints `[PIONEER_EVAL_ACTOR_CONTRACT]` to stderr with the actor working directory, `fixtures/`, and `case.json`. It follows with `[PIONEER_EVAL_FIXTURES]` lines for staged files.

The listing reads at most 256 KiB of `case.json`. Since actors can write the run directory, it ignores absolute, escaping, over-long, and control-character entries. It prints at most 20 paths, then counts the rest. Even without usable `case.json`, it prints the contract line.

Pi can write the isolated snapshot `agentDir` to create credential locks beside copied `auth.json` and `settings.json`. Pioneer never mounts the source Pi home.

Pioneer prints `[PIONEER_EVAL_WORK_LOG] ABSOLUTE_PATH` to stderr immediately after opening the controller log. Without `--work-log`, it creates a unique `eval-*.jsonl` in the platform Pioneer evals log directory. Explicit targets must be absolute, absent, free of control characters, and outside every actor-visible grant.

On macOS/Linux, parent folders must belong to you or root and deny writes by others. Trusted sticky folders such as `/tmp` can protect your entries. Otherwise another user could replace a folder with a link into actor storage after validation. Records contain only runner stages and bounded exit metadata. `[EVAL_WORK_LOG_CREATE_FAILED]` and `[EVAL_WORK_LOG_WRITE_FAILED]` stop the run.

Eval failures return nonzero and use stable stderr diagnostics:

- `[EVAL_FIXTURE_LEAK]`: prepare found a path or content marker that reveals the expected finding.
- `[EVAL_FIXTURE_TOO_LARGE]`: a prepare fixture exceeded 64 MiB.
- `[EVAL_TIMEOUT]`: the run timed out.
- `[EVAL_INTERRUPTED]`: SIGINT/SIGTERM interrupted the run.
- `[EVAL_SPAWN_FAILED]`: sandbox launch failed.
- `[EVAL_SHEBANG_RESOLUTION_FAILED]`: an `/usr/bin/env` interpreter chain was cyclic, excessively deep, or unterminated-overlong.
- `[EVAL_PROCESS_CONTAINMENT_FAILED]`: inherited pipes prevented proof that the process tree stopped.
- `[EVAL_OUTPUT_LIMIT]`: output exceeded a bound. The message names the stream and limit. For in-memory bounds, it also names `--stdout-file` or `--stderr-file`.
- `[PI_NO_MCP_VERSION_UNKNOWN]`: a tool-restricted Pi actor reached launch without a known version.
- The work-log failures above.

These diagnostics exclude the actor environment, Pi configuration, and authenticated proxy URL.

Pi actors get fast-start flags with skills disabled. Pi 1.0.4+ also gets `--no-mcp` after readiness, including deferred extension readiness and `--pi-home`, and after extension staging rebuilds the command. Custom non-Pi actors stay unchanged, including arguments such as `--tools` and `--no-extensions`.

Writable run directories and read-only runtime paths must be narrow and non-overlapping. After canonicalization, Pioneer rejects writable protected-system roots and descendants, plus broad filesystem, sensitive-configuration, temporary, variable-data, and home roots. Narrow read-only system runtimes and disposable temporary descendants remain supported. Networking is public-only unless `--allow-loopback` opens exact host ports.

Repeat `--allow-loopback HOST:PORT` to reach local apps through exact host loopback ports. `HOST` must be `127.0.0.1` or `localhost`. At most 16 distinct ports are allowed. Ranges, wildcards, other addresses, and IPv6 fail with `[EVAL_LOOPBACK_TARGET_INVALID]` before Pioneer reads the run directory.

On macOS, Seatbelt allows outbound TCP to exactly those ports. On Linux, a controller-owned Unix socket relays each port into the actor namespace. The supervisor listens on `127.0.0.1:PORT`; port 3128 is reserved for the proxy relay.

Actors get `NO_PROXY=127.0.0.1,localhost` so proxy-aware clients connect directly. The proxy still refuses loopback. Unlisted ports stay closed, and the mandatory probe uses a port outside the allow list. The work log records allowed targets.

Repeat `--env NAME=VALUE` to pass variables only to the actor. Names can contain letters, digits, and underscores. Pioneer rejects duplicates, `__proto__`, and controlled names with `[EVAL_ACTOR_ENV_INVALID]`. Controlled names include `PATH`, `HOME`, `TMPDIR`, proxy variables, `NODE_OPTIONS`, TLS configuration, Windows runtime variables, and all `PI_*`/`PIONEER_*` names, case-insensitively.

Pioneer accepts at most 64 variables, up to 32 KiB each and 64 KiB total. Logs record names without values.

Repeat `--pi-extension PATH` up to 8 times to load Pi extension files or packages that retain tools, such as an MCP adapter. The actor must be the trusted official Pi package. Directory entries resolve from `package.json` `pi.extensions` or `index.ts`/`index.js` and must stay inside the directory.

`package.json` must be a regular file no larger than 64 KiB, with at most 32 `pi.extensions` entries. Otherwise `[PI_EXTENSION_TOOL_SOURCE_INVALID]` stops the run before entry resolution. Pioneer stages the source and ancestor `node_modules` read-only under the explicit `--extension` location policy. It passes the staged copy with `--extension`.

Only that copy retains tools. Enabled user extensions and `-e` extensions remain tool-stripped. An extension already enabled in Pi or passed with `-e` fails with `[PI_EXTENSION_TOOL_SOURCE_INVALID]`. Add `--no-extensions` to the Pi command if needed.

Put required configuration, such as `mcp.json`, in the run directory and pass its Pi command flag. Only the actor loads the extension; discovery does not. It can use actor `--env` values, run-directory files, Pi arguments, and `--allow-loopback` ports during startup. Startup failure returns `[PI_EXTENSION_LOAD_FAILED]`.

## `pioneer eval install-linux`

On Ubuntu systems with restricted unprivileged user namespaces:

```bash
npm run build
sudo node dist/review-cli.js eval install-linux
```

Run the command as root. It copies `/usr/bin/bwrap` to root-owned `/usr/local/libexec/pioneer/bwrap` and loads one AppArmor profile. The profile grants `userns` only to that executable. The command changes no global sysctl.

## Environment

| Variable | Use |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Selects the source Pi agent directory when `--pi-home` is absent |
| `PATH` | Locates Pi, Node, and the CLI |
| `LANG`, `LC_ALL` | Preserved when present |
| `PIONEER_DEBUG` | Enables limited proxy diagnostics; never enable in routine use |

The controller sets run-local `HOME`, `TMPDIR`, proxy variables, `PI_OFFLINE`, and `PI_TELEMETRY`. Sandboxed actors do not inherit arbitrary host variables. `eval run --env` passes only named variables.

## `pioneer deep-review`

Run a versioned council/president deep review with a validated PR packet and trusted configuration. Pioneer core receives no GitHub credential on this path.

```text
pioneer deep-review --source DIR --packet FILE --config FILE
  [--output FILE] [--work-log FILE] [--scratch-base DIR]
```

Stdout contains a small machine-readable terminal summary. `[PIONEER_DEEP_REVIEW_WORK_LOG]` and `[PIONEER_DEEP_REVIEW_RESULT]` go to stderr. Exit codes are `0` for a complete clean review, `1` for publishable findings, and `2` for incomplete or unavailable runs. Windows stops before actor launch.

## `pioneer github deep-review`

Use these trusted GitHub adapter commands for same-repository workflows:

```text
pioneer github deep-review start --owner OWNER --repo REPO --head-sha SHA
pioneer github deep-review collect --source DIR --owner OWNER --repo REPO --pr N --head-sha SHA --output FILE
pioneer github deep-review publish --owner OWNER --repo REPO --pr N --result FILE --packet FILE --check-run-id ID
```

Collect and publish require `GITHUB_TOKEN`. Remove that token from the environment before running `pioneer deep-review`.
