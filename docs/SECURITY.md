# Security model

## Goal

Pioneer treats the reviewed repository, Pi tools, model output, and eval actors as untrusted. On macOS and Linux it aims to let Pi inspect explicitly granted material and use a private scratch directory without granting ambient access to the operator's files or direct network stack.

This is containment, not a claim that model output is correct or non-malicious.

## Trust boundaries

Trusted controller responsibilities:

- validate and canonicalize all paths;
- prepare a private Pi configuration snapshot;
- create and authenticate the network proxy;
- compile the native sandbox policy;
- parse bounded Pi RPC output;
- remove run-local state.

Untrusted actor inputs include the source tree, reference directories, eval fixtures, Pi skills copied into a review snapshot, commands invoked by Pi, provider responses, and the final report. Pi package content may be present in the copied home, but Pioneer disables extension discovery for review and eval actors.

## Filesystem policy

For reviews:

- the source and repeated `--allow-read` grants are read-only;
- the private native Pi session attempt directory is a separate controller-created writable path; prior attempts and the archive parent are never granted to the actor;
- the private scratch directory and repeated `--allow-write` grants are writable;
- an optional `--report` target is controller-owned, create-only, and never granted to the actor; it must be absolute, absent, and outside every actor-visible grant; Pioneer exclusively reserves it with a private random ownership marker bound to the controller's OS process-start identity plus a randomly named controller-owned sibling reservation link before announcing the path, so untrusted report text cannot impersonate an active reservation, live sidecars are protected before target-link creation, incomplete markers receive a one-minute setup grace, abandoned reservations are reclaimable after controller exit, inactive post-publication siblings are reclaimed by later default-report retention, and an orphaned link cannot block reuse of an absent target; Pioneer publishes through the owned reservation inode while a separate random publication lease protects it from concurrent retention, restores the marker after a failed write, treats close failure after successful sync and identity validation as cleanup without rewriting the report, and atomically quarantines each cleanup candidate before verifying and removing only the owned inode, so an unowned replacement is atomically moved to a fresh visible non-retained sibling before create-only restoration and Pioneer never deletes the preserved name; crash-left release quarantines receive a one-minute setup grace and are then reclaimed by default-report retention;
- every review work log is controller-owned, create-only, and never granted to the actor; an explicit `--work-log` target must be absolute, absent, free of control characters, and outside every actor-visible grant;
- a writable grant may not overlap the source or a read-only grant;
- filesystem roots and the user's home directory are rejected as grants;
- grant paths must exist, be directories, and not themselves be symbolic links;
- all accepted paths are canonicalized before policy construction.

Native resume archives are private per-user application-data directories with mode `0700` directories and `0600` manifests on POSIX; Windows relies on the per-user application-data ACL. XDG and Windows application-data overrides must be absolute. Before archive creation, archive loading, or default report preparation, Pioneer validates the lexical and canonical application-data ownership chain and, on POSIX, requires every directory to be caller- or root-owned and rejects replaceable group- or world-writable ancestry while allowing only trusted sticky directories that protect a caller-owned entry, then makes the Pioneer application directory private. Before creating or changing permissions on an archive root, Pioneer canonicalizes its prospective location and rejects overlap with the source, actor-visible read/write grants, or selected Pi-home snapshot source; creation and every load recheck the canonical root against those stored boundaries. Default controller report and work-log targets, plus every directory their preparation creates or changes, are likewise validated for overlap in both containment directions; Pioneer preflights both defaults before either can mutate storage, then revalidates each actual randomized target during preparation. Resume validates both explicit and derived default outputs outside the entire private resume store so one token cannot corrupt or expose another. The selected Pi-home source is canonicalized before its identity is frozen into resumable scope, preventing a retargeted symlink from silently changing credentials or configuration. The token is an identifier, not a filesystem capability. The manifest stores only schema, exact Pi version, scope metadata, and prompt digest—not prompts, reports, RPC streams, credentials, or session content; manifest reads are bounded at 1 MiB. Before retention Pioneer waits for process-tree close, rejects symlinks and special files, limits the committed resumable attempt to 32 MiB/5,000 entries so its next crash-safe copy fits, and enforces 64 MiB/10,000-entry bounds across retained attempts. Token loading acquires the archive lease before manifest, scope, attempt, or session-tree validation, releases that exact lease on any validation failure, and transfers it on success through output validation, readiness, copy, and execution. Lease contents are written completely to a private pending inode and hard-linked into the canonical lease path atomically, so contenders never observe an empty or partial lease; stale pending files are reclaimed with the other bounded temporary state. Resume accepts only retained or report-delivery-failed states recorded after process-tree closure; an `active` archive from an abruptly lost controller is rejected because the prior actor cannot be proven stopped. Resume then validates UUID containment, manifest integrity, source/grant scope, exact Pi version, and a new Windows acknowledgement without exposing its recovery point to concurrent pruning. Before each copy it removes crash-left staging attempts while holding that lease; it then stages and validates a copy while preserving symlink entries, atomically renames it, atomically replaces the manifest, and loads only the manifest's committed attempt, so a controller crash cannot strand the prior valid attempt or accumulate uncounted staging trees. If a resumed attempt becomes non-retainable or Pi rejects the copied session, Pioneer atomically restores the manifest to the validated prior attempt before removing the failed tree. Lease acquisition and release verify the exact private lease contents and OS process-start identity, probes fail closed on an `EPERM` PID check, concurrent pruning tolerates vanished candidates, and stale staging/manifest temporary files are reclaimed after retention. Count retention recomputes the current manifest ordering while holding the deletion candidate's lease, so a freshly retained recovery point is not removed from a stale snapshot. A pruning error after a successful retention is best effort and never rolls back the committed attempt. Failed containment never yields a token.

For evals, the actor run directory is the only persistent writable tree. The run directory and caller-supplied runtime reads must be narrow, existing canonical paths and must not overlap. The selected Pi home may not overlap the run directory or any runtime-read grant. Controller-derived executable reads already covered by the writable run tree are omitted rather than widened into redundant grants. Writable protected-system roots and their descendants, plus broad filesystem, sensitive-configuration, home, temporary, and variable-data roots and their canonical platform aliases, are rejected before sandbox construction; narrow read-only system runtimes and disposable temporary descendants remain available where execution requires them. A validated Pi package root may not contain or be contained by the writable run tree. Eval preparation canonicalizes the proposed output parent, requires it to remain outside the source skill, and revalidates the created destination before writing descendants. It accepts `skill_name` only as one non-empty, non-dot, cross-platform-safe path component within the 255-byte filename limit, including rejection of Windows reserved device names, invalid characters, and trailing dots or spaces, then verifies destination containment before copying. Actor-visible eval trees may not contain symlinks.

## Pi configuration and credentials

The controller copies the selected Pi agent directory into a private run area and sets `PI_CODING_AGENT_DIR` to the copy. It never mounts the real directory into the actor. Eval validation rejects a real Pi home that overlaps any actor grant. Eval copies and controller launch/probe files live in a canonical private temporary tree outside the persistent actor run. The selected eval Pi configuration is read-only; only its separate home/tmp scratch is writable, and an outer signal scope guarantees that the entire temporary tree is removed even when interruption occurs before actor launch.

The snapshot is positive by default. It copies only root `auth.json`, `models.json`, `models-store.json`, `settings.json`, and `AGENTS.md`; review snapshots additionally traverse `skills/`, while eval snapshots exclude it. Traversal of `skills/` skips `node_modules/`, `.git/`, `.npm/`, `.cache/`, transient directories, and log files. Root-level `npm/`, `git/`, and unknown paths are outside the allowlist, while valid skill directories such as `skills/git/` and `skills/npm/` remain visible. Review callers can add repeated `--pi-home-include RELATIVE_PATH` exact paths to select otherwise skipped `node_modules/`, `.git/`, or unknown files/directories. Paths are relative to the selected source Pi home; globs, negation, configuration files, and eval opt-ins are not supported.

The hard exclusions that cannot be overridden are `sessions/`, `logs/`, `.npm/`, `.cache/`, `tmp/`, `.tmp/`, `temp/`, and files ending in `.log` (including debug logs), at any depth. Exclusion matching follows platform filename semantics: macOS and Windows fold case, including for explicit includes, while Linux remains case-sensitive. The controller deduplicates overlapping selections, rejects destination collisions, and counts only selected entries and file bytes toward the 500,000-entry and 1 GiB backstops. Opting in large or machine-specific package trees increases review time, storage, and portability risk.

The copy rejects special files, broken links, and links escaping the Pi home. An internal symlink is preserved only when its resolved target is also selected; otherwise the snapshot fails with a relative target and an opt-in diagnostic where policy permits. This prevents a selected skill from silently pulling an excluded package store into the snapshot. Symlinked Pi launcher names directly under an unselected `bin/` tree are not copied; Pioneer launches the separately resolved host Pi executable.

The copy is bounded to 500,000 entries and 1 GiB after exclusions. Provider authentication should therefore be configured in Pi's agent directory, normally through `pi` and `/login`. Host API-key environment variables are intentionally not copied wholesale into sandboxed runs.

When Pi reports no configured models, readiness checks only filesystem access permissions on the agent directory and the known configuration filenames `auth.json`, `models-store.json`, and `settings.json`. It never opens or reads those files. A permission denial is reported as an outer-terminal sandbox problem rather than misleading the user to reconfigure Pi.

When Pi reports that `models.json` could not be loaded, Pioneer rejects the entire catalog even if Pi also prints cached or built-in models. The stable diagnostic does not repeat Pi's raw provider-specific error text.

Some policy sandboxes, including macOS Seatbelt configurations, allow metadata checks while withholding file contents. When Pi reports no models in such an environment, a recognized outer-agent sandbox indicator triggers the same conservative diagnosis. Only the indicator's variable name is reported, never its value. Callers can set `PIONEER_OUTER_SANDBOX=1` when their sandbox is not recognized automatically.

## Environment policy

Pi readiness probes receive an allowlist of runtime, home-directory, certificate, temporary-directory, and `PI_CODING_AGENT_DIR` variables. Provider secrets, coding-agent control state, and other ambient host variables are not inherited. Pi authentication and provider configuration should come from the selected Pi agent directory.

Review actors receive only the controller-selected runtime variables, Pi's isolated `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR`, proxy variables, and minimal locale/path settings. This narrow environment applies on Windows too, even though Windows review filesystem isolation remains instruction-only. Eval actors receive an even narrower broker environment. A mandatory eval probe verifies that a controller-only secret is absent.

Neither debug output nor errors should contain Pi credentials, proxy tokens, prompts, or full environment dumps. Work logs contain controller lifecycle records and a field allowlist of Pi RPC metadata. They omit prompts, assistant text and thinking, message bodies, tool arguments and results, queue contents, extension paths, proxy values, environment values, and provider diagnostic text. Provider-controlled response, assistant-error, and stderr text is represented to callers only by stable state, presence, count, and byte metadata. Readiness metadata and controller-owned diagnostic fields that must remain visible are whitespace-normalized, capped at 500 characters, and redacted for common authorization, authenticated-URL, signed-URL query, cookie, session, connection-string, passphrase, token, key, password, and secret forms. Requested-model errors sanitize and cap the untrusted requested name separately, then preserve the complete catalog assembled from validated provider and model fields.

## Network policy

All sandboxed network access is proxy-mediated and authenticated with a per-run random token.

| Mode | Destinations | Intended use |
| --- | --- | --- |
| `full` | Public internet, LAN, and loopback through the proxy | Default review mode; allows probing a local deployment |
| `public` | Globally routable destinations only | Reviews that do not need local services; all evals |
| `none` | No proxy and no outbound grant | Offline reviews |

Public-only resolution rejects local suffixes and non-global IPv4/IPv6 ranges. It requires every DNS answer to be public, then connects to a selected validated address rather than resolving again. This closes the normal DNS-rebinding window.

On Linux, the actor has a private network namespace. A small Node supervisor exposes only a loopback port relayed to one mode-0600 Unix socket connected to the parent proxy. Raw host, LAN, or public TCP is unavailable; tools must honor standard HTTP(S) proxy variables.

## Platform enforcement

### macOS

The controller runs `/usr/bin/sandbox-exec` with a generated Seatbelt profile starting from `deny default`. Read/write grants and ancestor metadata traversal are explicit. Network access is limited to the authenticated loopback proxy port.

macOS uses the legacy `sandbox-exec` interface, for which Apple provides no public drop-in replacement for dynamically sandboxing arbitrary CLI processes. Mandatory live smoke tests detect removal or semantic drift.

### Linux

Bubblewrap creates an empty tmpfs root, explicit read-only and writable binds, new user/PID/network/IPC/UTS namespaces, private `/proc` and `/dev`, parent-death behavior, and no capabilities. The detached controller capture process owns the dedicated session/process group used for containment and termination. Ubuntu systems that restrict unprivileged user namespaces can use the narrow root-owned Bubblewrap copy and AppArmor profile described in [EVALS.md](EVALS.md).

### Windows

Review isolation is not enforced. The caller must explicitly pass `--allow-unsandboxed-windows`; the CLI returns a warning and relies on instructions to Pi. Strict eval execution fails closed before actor launch. See [WINDOWS-SANDBOX-PROTOTYPE.md](WINDOWS-SANDBOX-PROTOTYPE.md).

## Process and output controls

- Every subprocess uses discrete argv with `shell: false`; Windows controller helpers use absolute paths under the validated system root rather than current-directory or `PATH` lookup.
- Review RPC buffers are limited to a cumulative 20 MiB by default and 64 MiB maximum; stderr retains only the final 64 KiB. The collector counts raw stdout bytes before JSON decoding and reports stable `[REVIEW_RPC_OUTPUT_LIMIT]` diagnostics plus bounded byte metadata.
- Eval actors are resolved and validated before sandbox artifacts are created. Bare executable lookup uses only the sanitized selected `PATH`; relative paths are anchored to the validated run directory; symlink launchers grant only their exact lexical path and canonical target. `/usr/bin/env` shebang inspection reads a bounded prefix and follows canonical interpreter paths only through a bounded, cycle-checked chain. Eval capture uses a distinct native process group, close-based completion, a bounded pipe-close grace period, and group termination on timeout or interruption. Partial output is retained within 4 MiB stdout and 64 KiB stderr limits, with stable nonzero diagnostics for timeout, interruption, spawn, shebang-resolution, containment, and output-limit failures.
- Review work logs are mode `0600` on macOS and Linux. Default Windows logs use the per-user `%LOCALAPPDATA%` directory ACL; a custom Windows target inherits its existing parent directory ACL, which Pioneer cannot validate, so a parent private to the current user is a caller precondition. Logs are synchronously written after every JSONL record, synced by a dirty-log timer within one second and again on close, limited to 16 MiB per run, and fail the review after writing an explicit truncation record at the bound. A worker thread refreshes each private nonce-backed active lease independently of the controller event loop, and the marker carries the owner's OS process-start identity. A stale-looking lease is preserved when both its PID and process identity still match, handling suspension and clock steps without treating PID liveness alone as ownership; legacy markers and temporarily unavailable identity lookups receive one bounded renewal interval. Abandoned leases expire after crashes or PID reuse and are reclaimed by both creation-time and close-time retention. Both passes complete their bounded critical section synchronously under a private cross-process lock whose PID, nonce, and OS process-start identity are atomically published. Windows derives both owner and inspector identity from the same OS process-start timestamp and uses a narrow millisecond-scale hashed window to absorb clock-source rounding; Linux uses kernel boot/start ticks, and macOS hashes a C-locale UTC start time. Suspension preserves identity while PID reuse changes it, and release verifies the exact owner record before unlinking. A closer renews its log lease until it owns that lock; its pass excludes its finishing target, tolerates concurrently vanished candidates, and orders inactive candidates by last write time while pruning toward the newest 100 total. Pioneer does not rotate custom targets outside that reserved naming pattern.
- Readiness output is limited to 64 KiB per stream.
- Reviews default to a 15-minute timeout; eval actors default to five minutes.
- Cleanup runs even after failure or timeout.

## Package updates

Pioneer checks only the fixed `@rock3r/pioneer` npm package name and public npm registry, with fixed npm arguments, bounded output, and a five-second timeout. It invokes npm's CLI with the running Node interpreter and the CLI from that distribution or a fixed system package-manager path rather than the caller's `PATH`, runs from a private empty directory, and supplies null user/global npm config paths with a constrained cross-platform environment. Repository-local and home-directory npm configuration, and ambient npm tokens, therefore cannot affect either the check or install. Global installs preserve the prefix structurally derived from Pioneer's own package location, never from npm configuration. Normal checks are best-effort: they run in parallel with the requested command, do not affect its result, and cache both successful and failed check times for 24 hours. The cache contains only a timestamp and the public package version.

`pioneer update` always performs a fresh version check and never changes an installation without confirmation or `--yes`. If requested, it retrieves bounded GitHub release notes for the selected public version before delegating the global install to npm as discrete argv. Neither update path reads Pi configuration or forwards credentials.

## Residual risks

- Review skills execute inside the sandbox and can still alter the review, exfiltrate any granted content through permitted networking, or write to explicit writable grants. Optional Pi extensions are not discovered by Pioneer actors.
- `full` review networking intentionally permits proxy access to LAN and loopback services.
- A writable reference path is a real host write capability. Grant it sparingly.
- Proxy-unaware tools cannot use Linux networking.
- Windows reviews have no OS filesystem boundary.
- A descendant that deliberately escapes the expected process-group behavior may retain resources until the bounded containment grace expires; Pioneer reports containment failure and destroys its capture streams, but cannot retroactively revoke resources outside the native sandbox.
- The current result is free-form model output, not a schema-validated finding set.

Report suspected sandbox escapes or credential disclosure privately to the maintainers before publishing details.
