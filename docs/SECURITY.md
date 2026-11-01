# Security model

## Goal

Pioneer treats repositories, Pi tools, model output, and eval actors as untrusted. On macOS and Linux, Pi receives explicit file grants and private scratch. The sandbox blocks ambient access to operator files and the direct network stack.

Model output can still be incorrect or malicious. Callers must review it before acting on it.

## Trust boundaries

Trusted controller responsibilities:

- validate and canonicalize all paths;
- collect Git-target review context with a canonical Git executable, argument arrays, and an allowlisted read-only subcommand set;
- prepare a private Pi configuration snapshot;
- create and authenticate the network proxy;
- compile the native sandbox policy;
- parse bounded Pi RPC output;
- remove run-local state.

Untrusted actor inputs include the source tree, reference directories, Git refs and command output, eval fixtures, Pi skills copied into a review snapshot, commands invoked by Pi, provider responses, and the final report. Reviews and evals load enabled user extensions from a separate read-only snapshot. Extension tools are removed in both. Ambient discovery stays off. See [Pi extensions](PI-EXTENSIONS.md) for resolution, tool policy and arbitrary-code limits.

## Filesystem policy

For reviews:

- the source and repeated `--allow-read` grants are read-only;
- the private native Pi session attempt directory is a separate controller-created writable path; prior attempts and the archive parent are never granted to the actor;
- the private scratch directory and repeated `--allow-write` grants are writable;
- The controller owns each create-only report target, including `--report`. It must be absolute, absent, and outside every actor-visible grant.
- every review work log is controller-owned, create-only, and never granted to the actor; an explicit `--work-log` target must be absolute, absent, free of control characters, and outside every actor-visible grant;
- On macOS and Linux, output ancestors must belong to the caller or root. This includes ancestors of the nearest existing folder when Pioneer creates descendants.
  Other users must have no write access unless a sticky directory protects the caller-owned entry below it. Otherwise they could replace a validated folder with a link into an actor grant.
- a writable grant may not overlap the source or a read-only grant;
- filesystem roots and the user's home directory are rejected as grants;
- grant paths must exist, be directories, and not themselves be symbolic links;
- all accepted paths are canonicalized before policy construction.

### Report reservation and publication

Pioneer reserves reports before announcing their paths. It creates a private random ownership marker bound to the controller's OS process-start identity. A randomly named controller-owned sibling link also identifies the reservation. Untrusted report text cannot impersonate an active owner.

Retention protects live sidecars before target-link creation and gives incomplete markers one minute for setup. After controller exit, it can reclaim abandoned reservations. Later default-report retention also reclaims inactive post-publication siblings. An orphaned link cannot prevent reuse of an absent target.

Pioneer writes through the owned reservation inode. A separate random publication lease protects the inode during writes. Failed writes restore the marker. After successful sync and target-identity validation, close failures count as cleanup failures and cannot rewrite the durable report.

Cleanup atomically quarantines each candidate before checking ownership. It removes only owned inodes. For an unowned replacement, it first moves the inode to a fresh visible `pioneer-preserved` sibling outside retention. It then attempts create-only restoration of the original path. Pioneer never deletes the preserved name.

Default-report retention gives crash-left release quarantines one minute for setup, then reclaims them.

### Native resume archive privacy

Pioneer stores native resume archives in private per-user application-data directories. POSIX directories use mode `0700`, and manifests use `0600`. Windows relies on the per-user application-data access control list (ACL). XDG and Windows application-data overrides must be absolute.

Before archive creation, archive loading, or default report preparation, Pioneer validates both the lexical and canonical application-data ownership chains. On POSIX, every directory must belong to the caller or root. Pioneer rejects replaceable group- or world-writable ancestors. It allows trusted sticky directories only when they protect a caller-owned entry. It then makes the Pioneer application directory private.

### Archive and output boundaries

Before creating or changing permissions on an archive root, Pioneer canonicalizes its prospective location. It rejects overlap with the source, actor-visible read/write grants, or selected Pi-home snapshot source. Creation and every load recheck the canonical root against those stored boundaries.

Pioneer also checks default report and work-log targets, including every directory their preparation creates or changes, for overlap in both containment directions. It preflights both defaults before either can change storage. During preparation, it revalidates each actual randomized target.

Resume requires explicit and derived default outputs to stay outside the entire private resume store. This prevents one token's outputs from corrupting or exposing another archive. Pioneer canonicalizes the selected Pi-home source before fixing its identity in resumable scope. Retargeting a symlink therefore cannot silently change the selected credentials or configuration.

Filesystem permissions control archive access. A token supplies only the archive identifier.

### Manifest and retention limits

The manifest stores only the schema, exact Pi version, scope metadata, and prompt digest. It excludes prompts, reports, RPC streams, credentials, and session content. Pioneer bounds manifest reads at 1 MiB and type-checks every present immutable-scope field without filtering or omission. It rejects and prunes lifecycle timestamps more than five minutes in the future.

Before retention, Pioneer waits for the process tree to close and rejects symlinks and special files. A committed resumable attempt can contain at most 32 MiB and 5,000 entries, leaving room for its next crash-safe copy. All retained attempts together can contain at most 64 MiB and 10,000 entries.

### Archive leases

Token loading acquires the archive lease before validating the manifest, scope, attempt, or session tree. Any validation failure releases that exact lease. On success, Pioneer holds it through output validation, readiness, copying, and execution.

Pioneer writes complete lease contents to a private pending inode, then atomically hard-links it into the canonical lease path. Contenders cannot observe an empty or partial lease.

If stale takeover discovers that it displaced a replacement owner, Pioneer restores that owner through a create-only hard link. It cannot overwrite a third contender. A restoration collision preserves the displaced inode. Every publisher checks for a live displaced owner and waits before acquiring a lease. Pioneer reclaims stale pending files with the other bounded temporary state.

Lease acquisition and release verify the exact private lease contents and operating-system process-start identity. Probes fail closed on an `EPERM` process-ID check.

### Resume validation and crash recovery

Resume accepts only retained or report-delivery-failed states recorded after process-tree closure. Pioneer rejects an `active` archive left by an abruptly lost controller because it cannot prove that the prior actor stopped.

While holding the lease, Pioneer validates UUID containment, manifest integrity, source/grant scope, the exact Pi version, and a new Windows acknowledgement. Concurrent pruning cannot remove this recovery point.

Before each copy, Pioneer removes staging attempts left by a crash while holding the lease. It stages and validates a copy while preserving symlink entries, atomically renames it, and atomically replaces the manifest. It loads only the manifest's committed attempt. A controller crash therefore cannot strand the prior valid attempt or accumulate uncounted staging trees.

If a resumed attempt becomes non-retainable or Pi rejects the copied session, Pioneer atomically restores the manifest to the validated prior attempt. It then removes the failed tree.

### Pruning and containment failures

Concurrent pruning tolerates vanished candidates. Pioneer reclaims stale staging and manifest temporary files after retention. Count retention recomputes the current manifest ordering while holding the deletion candidate's lease. A stale snapshot therefore cannot cause deletion of a freshly retained recovery point.

A pruning error after successful retention never rolls back the committed attempt. Failed containment takes precedence over any earlier RPC, timeout, or work-log failure and never yields a token.

### Eval filesystem boundaries

The actor run directory is the only persistent writable eval tree. Work logs and `--stdout-file`/`--stderr-file` targets follow the review-output folder-chain rule. Only the caller or root can change their ancestors. Another process running as the caller can still modify those files directly.

Run directories and caller runtime reads must be narrow, existing canonical paths without overlap. The selected Pi home must stay outside all actor grants. Pioneer omits redundant read-only executable grants already covered by the writable run tree. Validated Pi package roots must not overlap that tree in either direction.

Before sandbox construction, Pioneer rejects writable protected-system roots and descendants. It also rejects broad filesystem, sensitive-configuration, home, temporary, and variable-data roots and canonical aliases. Required narrow read-only system runtimes and disposable temporary descendants remain available.

Preparation canonicalizes the output parent and requires it to stay outside the source skill. It revalidates the created destination before writing descendants. Actor-visible eval trees cannot contain symlinks.

`skill_name` must be one non-empty, non-dot, cross-platform-safe component within the 255-byte filename limit. Pioneer rejects Windows reserved names, invalid characters, and trailing dots/spaces. It checks destination containment before copying.

Before output creation, preparation rejects revealing fixture paths or contents with `[EVAL_FIXTURE_LEAK]`. [EVALS.md](EVALS.md) lists the exact rules.

Each `files[]` entry must be a regular file of at most 64 MiB. Pioneer opens fixtures without following final symlinks or blocking on FIFOs. It checks type and size with `fstat` on that descriptor. Directories and special files fail validation. Oversized files fail with `[EVAL_FIXTURE_TOO_LARGE]`.

The content scanner streams from the same descriptor with bounded memory. Pioneer records device, inode, size, modification/change times, and permission bits, then closes the file. Preparation holds at most one fixture descriptor at a time.

Each copy reopens the fixture and checks its identity before and after copying. Changes fail with `[EVAL_FIXTURE_CHANGED]`. Pioneer rescans every copied byte and rechecks size while streaming. Files growing past the limit also fail. These checks apply to the actual bytes staged under `fixtures/`.

If the second scan fails, Pioneer removes the staged copy and stops. It leaves the partly prepared output directory. Do not use that directory.

## Pi configuration and credentials

The controller copies selected Pi configuration into a private run area and points `PI_CODING_AGENT_DIR` at the copy. It never mounts the real Pi home. Eval validation rejects a real home overlapping any actor grant.

Eval copies and controller launch/probe files use a canonical private temporary tree outside the persistent actor run. The base defaults to the platform's short shared temporary directory.

Review and eval callers can supply `controllerScratchBase`. Pioneer canonicalizes it and rejects missing paths, non-directories, broad/protected system locations, and paths too long for the bridge socket. Actor write grants follow this base.

The caller must own the base. Its ownership chain must block other users from replacing it. Sticky directories that protect caller-owned entries are allowed; default `/tmp` at mode 1777 meets this rule. Pioneer uses the same ownership-chain checks as review application-data preparation.

A supplied base cannot sit inside an actor grant. Otherwise controller creation and cleanup would cross a promised read-only mount or create overlapping grants. Sharing an ancestor with a grant is allowed because generated scratch remains a sibling.

Pioneer adopts review and eval scratch directories without following symlinks. It rejects replacements between creation and use before copying configuration or recursively cleaning the directory.

Eval configuration uses an isolated writable `agentDir` so Pi can create locks beside `auth.json` and `settings.json`. Home/tmp scratch is separate and writable. These are the only writable parts of the temporary tree. Pioneer removes the snapshot on every exit path. An outer signal scope also covers interruptions before actor launch.

The default root allowlist contains `auth.json`, `models.json`, `models-store.json`, `settings.json`, and `AGENTS.md`. Reviews also traverse `skills/`; evals exclude it.

Skills traversal skips `node_modules/`, `.git/`, `.npm/`, `.cache/`, transient directories, and log files. Root-level `npm/`, `git/`, and unknown paths remain outside the allowlist. Valid `skills/git/` and `skills/npm/` directories remain visible.

Reviews accept repeated `--pi-home-include RELATIVE_PATH` options for otherwise skipped files or directories, including `node_modules/` and `.git/`. Each path is exact and relative to the source Pi home. Includes accept no globs, negation, or configuration files. Evals have no include option.

Hard exclusions apply at every depth: `sessions/`, `logs/`, `.npm/`, `.cache/`, `tmp/`, `.tmp/`, `temp/`, and files ending in `.log`, including debug logs.

Inside explicitly included `node_modules/` packages, directories named `sessions/`, `logs/`, `tmp/`, `.tmp/`, and `temp/` contain package source and stay included. `.npm/`, `.cache/`, and `.log` files remain excluded there.

Configured session storage inside the Pi home remains excluded, even inside dependencies. Pioneer reads its location from `PI_CODING_AGENT_SESSION_DIR` or `sessionDir`. A leading `~` expands against Pi's environment home directory. Relative values fail with `PI_SESSION_DIR_RELATIVE` because Pioneer cannot know Pi's original working directory.

Pioneer normalizes other values like Pi, including `file://` URLs and Windows Git Bash, Cygwin, and WSL drive paths. Linked root `sessions/`, `logs/`, and `.log` files also exclude their canonical targets inside the home. [Content checks](#session-history-outside-known-locations) identify session files elsewhere.

On filesystems without directory-entry types, including some FUSE and network filesystems, Pioneer uses `lstat` for each entry. macOS and Windows fold case for exclusions and explicit includes. Linux keeps case-sensitive matching.

The controller deduplicates overlapping selections and rejects destination collisions. Only selected entries and file bytes count toward the 500,000-entry and 1 GiB limits. Large or machine-specific includes increase review time, storage, and portability risk.

The copy rejects special files, broken links, and links escaping the Pi home. An internal symlink is preserved only when its resolved target is also selected; otherwise the snapshot fails with a relative target and an opt-in diagnostic where policy permits. This prevents a selected skill from silently pulling an excluded package store into the snapshot. Symlinked Pi launcher names directly under an unselected `bin/` tree are not copied; Pioneer launches the separately resolved host Pi executable.

The copy is bounded to 500,000 entries and 1 GiB after exclusions. Provider authentication should therefore be configured in Pi's agent directory, normally through `pi` and `/login`. Host API-key environment variables are intentionally not copied wholesale into sandboxed runs.

When Pi reports no configured models, readiness checks only filesystem access permissions on the agent directory and the known configuration filenames `auth.json`, `models-store.json`, and `settings.json`. It never opens or reads those files. A permission denial is reported as an outer-terminal sandbox problem rather than misleading the user to reconfigure Pi.

When Pi reports that `models.json` could not be loaded, Pioneer rejects the entire catalog even if Pi also prints cached or built-in models. The stable diagnostic does not repeat Pi's raw provider-specific error text and directs callers to rerun Pioneer outside an outer sandbox before editing configuration, because a sandbox can prevent Pi from creating required configuration lock files.

Some policy sandboxes, including macOS Seatbelt configurations, allow metadata checks while withholding file contents. When Pi reports no models in such an environment, a recognized outer-agent sandbox indicator triggers the same conservative diagnosis. Only the indicator's variable name is reported, never its value. Callers can set `PIONEER_OUTER_SANDBOX=1` when their sandbox is not recognized automatically.

## Session history outside known locations

Pioneer cannot find every Pi session directory by location, so both snapshots also exclude Pi session files by content.

Pi merges global and project `sessionDir` settings. The project file is `.pi/settings.json` where the operator starts Pi. Pi reads it before resolving project trust. Project values override global values. Operators can also pass `--session-dir`.

Pioneer sees only `PI_CODING_AGENT_SESSION_DIR` and global `settings.json`. Other projects can place sessions inside extension roots, selected `node_modules`, `skills/`, or explicit include paths. Content checks prevent those files from entering snapshots.

Verification used Pi 1.2.0's `SettingsManager` and `SessionManager` to write sessions in extension and Pi-home include paths. Without content checks, both snapshots copied those files. This test used Pi's library APIs without running the full CLI.

Pi stores sessions as `.jsonl` files. It skips blank, malformed, and falsy lines to find the first parseable header. Pioneer applies the same rule to regular files ending in `.jsonl`, without case sensitivity.

For links, Pioneer checks both the lexical and canonical target names. It checks multiply hard-linked files regardless of name because another name can end in `.jsonl`.

A JSON object header with `type: "session"` identifies history. Pi also requires a string `id`; Pioneer's broader rule fails closed. Pioneer scans at most about 1 MiB per header. It treats files without a header in that range as history. Pi 1.2.0 uses the same listing limit.

The two snapshots handle a detected file as follows:

| Situation | Extension snapshot | Pi-home snapshot |
| --- | --- | --- |
| Session file found while traversing a directory | Skipped | Skipped |
| Link to a session file, or a `.jsonl` link to a file that holds a session header | Skipped | Refused with `PI_HOME_SYMLINK_TARGET_EXCLUDED` |
| Default root file, such as `AGENTS.md`, that is a link to a session file | Not applicable | Skipped |
| `--pi-home-include` names a session file | Not applicable | Refused with `PI_HOME_INCLUDE_INVALID` |
| Copied file is session history, because it changed after the check | Refused with `PI_EXTENSION_SNAPSHOT_CHANGED` | Refused with `PI_HOME_SNAPSHOT_CHANGED` |
| Selected file was replaced, gained a `.jsonl` hard link, or a selected link was repointed to session history before the copy | Refused with `PI_EXTENSION_SNAPSHOT_CHANGED` | Refused with `PI_HOME_SNAPSHOT_CHANGED` |

Pioneer does not read the reviewed repository's `.pi/settings.json` for this. The content rule does not need it, and trusting it would let a repository change snapshot policy or fail a review with an invalid value. The reviewed repository's settings also cannot redirect the review's own session: Pioneer always passes `--session-dir`, `--session`, or `--no-session`, and Pi gives those flags precedence over settings.

Header scans have separate per-snapshot totals of 500,000 opened files and 1 GiB read. Every scan counts, including skipped history. Pi-home totals also include link-target and copied-file checks. Exceeding a total stops preparation with `PI_HOME_SNAPSHOT_LIMIT` or `PI_EXTENSION_SNAPSHOT_LIMIT`. Selected-content limits remain separate.

Extension scans apply these limits per staging call. An eval staging user, explicit, and `--pi-extension` code in three calls can read 1 GiB in each call. Many `.jsonl` files with long blank or malformed prefixes can still slow preparation.

Renaming singly linked session files away from `.jsonl` can evade detection. Changing the first parseable line to a non-session header also evades it. Pi would not list those files as sessions either. Keep session storage outside extension, dependency, and skill directories.

## Environment policy

Pi readiness probes receive an allowlist of runtime, home-directory, certificate, temporary-directory, and `PI_CODING_AGENT_DIR` variables. Provider secrets, coding-agent control state, and other ambient host variables are not inherited. Pi authentication and provider configuration should come from the selected Pi agent directory.

Review actors receive only the controller-selected runtime variables, Pi's isolated `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR`, proxy variables, and minimal locale/path settings. This narrow environment applies on Windows too, even though Windows review filesystem isolation remains instruction-only. Eval actors receive an even narrower broker environment. A mandatory eval probe verifies that a controller-only secret is absent.

Debug output and errors must exclude Pi credentials, proxy tokens, prompts, and full environment dumps. Work logs contain controller lifecycle records and allowlisted Pi RPC metadata.

Logs omit prompts, assistant text/thinking, message bodies, tool arguments/results, queues, extension paths, proxy/environment values, and raw provider diagnostics. A review failure may include a sanitized provider excerpt and a classified cause (`auth_refresh`, `missing_credentials`, `quota_or_rate_limit`, `unsupported_model`, `transport`, `timeout_or_cancellation`, `missing_report`, or `unclassified`). The work log records that cause, provider, status, and provider code, not the excerpt. Pioneer does not invent a cause, and it does not refresh credentials or change billing routes from a diagnostic.

Early/nonzero Pi exits and failed readiness probes add an allowlisted stderr summary. Allowed fields include error class, known Node error code/syscall, staged extension package name, and Pioneer adapter diagnostic codes. For example: `error=Error; code=EPERM; syscall=spawn; package=pi-subagents`.

Summaries exclude stderr message text and paths. Untrusted stderr can contain credentials that pattern redaction misses.

Visible readiness metadata and controller diagnostics normalize whitespace and cap fields at 500 characters. Redaction covers common authorization, authenticated-URL, signed-URL query, cookie, session, connection-string, passphrase, token, key, password, and secret formats.

Requested-model errors separately sanitize and cap the requested name. They preserve the complete catalog built from validated provider and model fields.

## OAuth refresh in native reviews and evals

The broker serializes up to eight pending requests instead of rejecting overlapping refreshes. Source OAuth storage must be a regular `auth.json` file: symlinks are rejected because Pi names locks from the lexical credential path. Only snapshot OAuth providers are intercepted; other private-store updates retain Pi's ordinary behavior.

Native reviews, deep reviews, and evals on a trusted Pi package that can host the auth adapter broker OAuth refreshes, including built-in-only reviews and evals. A private authenticated endpoint accepts only a provider name from the original snapshot's OAuth providers. It accepts no credentials, update payloads, or filesystem paths from the review actor. The proxy pins the broker's randomized hostname to its exact loopback port; other destinations retain the requested public/full policy. Concurrent requests within one broker are bounded, and Pi's own source `auth.json` lock serializes refreshes across Pioneer processes and ordinary Pi.

Under Pi's lock, the controller copies current configuration into separate worker scratch. It replaces the worker credential file with only the requested provider's current credential. Installed Pi runs provider authentication inside a native sandbox.

Before initializing extensions, the worker captures that credential in Pi's in-memory auth store. The result comes from the store's authentication API. Later changes to `auth.json` cannot supply it.

The worker loads the read-only extension snapshot. It receives no model, prompt, session, reviewed source, review scratch, or original Pi-home grant. User extension code never runs in the controller.

The controller opens the result handle before launch. Worker-created links or replaced parents cannot redirect the read. It validates a bounded OAuth record and merges only the requested provider into locked source credentials. It never copies review-agent credential changes back.

The authentication worker is a separate trust domain from the review process. Operator-enabled provider code is trusted to produce its provider's credentials, just as in normal Pi. Its native sandbox limits filesystem and network authority; it does not mutually isolate JavaScript extensions within the authentication process. An intentionally malicious installed extension that subverts the authentication API is outside that guarantee. Neither a model response nor reviewed repository content is evaluated by this worker.

The controller writes source rotations before temporary cleanup. Later worker failures cannot undo an already-written rotation. Broker shutdown waits for active refresh writes before removing snapshots. Errors and work logs exclude provider diagnostics and credentials.

Abrupt failure between remote rotation and local persistence can still require reauthentication, as in ordinary Pi. The broker cannot recover a token invalidated by an earlier run.

Evals use the same broker with public networking, including commands with `--no-extensions` or `-ne`. The controller writes refreshed source credentials before removing the snapshot. If a snapshot contains OAuth credentials and Pi cannot host the auth adapter, the eval fails before launch.

## Network policy

All sandboxed network access is proxy-mediated and authenticated with a per-run random token.

| Mode | Destinations | Intended use |
| --- | --- | --- |
| `full` | Public internet, LAN, and loopback through the proxy | Default review mode; allows probing a local deployment |
| `public` | Globally routable destinations only | Reviews that do not need local services; all evals, apart from exact `--allow-loopback` ports |
| `none` | No proxy and no outbound grant | Rejected for reviews because Pi cannot reach its configured model provider |

Public-only resolution rejects local suffixes and non-global IPv4/IPv6 ranges. It requires every DNS answer to be public, then connects to a selected validated address rather than resolving again. This closes the normal DNS-rebinding window.

On Linux, the actor has a private network namespace. A small Node supervisor exposes only a loopback port relayed to one mode-0600 Unix socket connected to the parent proxy. Raw host, LAN, or public TCP is unavailable; tools must honor standard HTTP(S) proxy variables.

`eval run --allow-loopback 127.0.0.1:PORT` explicitly grants raw TCP access to an exact host loopback port. macOS adds a Seatbelt outbound rule for each port. Linux uses a dedicated mode-0600 Unix socket relay and an in-namespace supervisor listener.

Ports must be exact integers and hosts must use IPv4 loopback. The actor receives `NO_PROXY=127.0.0.1,localhost`. The proxy still refuses loopback. Mandatory probes test an unlisted listener under the same policy. Any service on an allowed port must tolerate untrusted actor requests.

## Platform enforcement

### macOS

The controller runs `/usr/bin/sandbox-exec` with a generated Seatbelt profile starting from `deny default`. Read/write grants and ancestor metadata traversal are explicit. `/dev/null` may be opened for reading and writing because process spawning with ignored stdio and Git require it; it discards writes and reads as empty. Network access is limited to the authenticated loopback proxy port and any eval `--allow-loopback` ports.

macOS uses the legacy `sandbox-exec` interface, for which Apple provides no public drop-in replacement for dynamically sandboxing arbitrary CLI processes. Mandatory live smoke tests detect removal or semantic drift.

### Linux

Bubblewrap creates an empty tmpfs root, explicit read-only/writable binds, new user/PID/network/IPC/UTS namespaces, and private `/proc` and `/dev`. It drops all capabilities and enables parent-death behavior. The detached capture controller owns the session/process group used for termination.

Bubblewrap runs as PID 1 in the actor's PID namespace. When the actor exits, the kernel destroys every remaining namespace process. Descendants cannot retain pipes beyond the run, so `[EVAL_PROCESS_CONTAINMENT_FAILED]` is unreachable on Linux.

All required Bubblewrap options exist in 0.2.0 or newer. Pioneer does not probe its version. Ubuntu users with restricted user namespaces can install the root-owned Bubblewrap copy and narrow AppArmor profile in [EVALS.md](EVALS.md).

### Windows

Review isolation is not enforced. The caller must explicitly pass `--allow-unsandboxed-windows`; the CLI returns a warning and relies on instructions to Pi. Strict eval execution fails closed before actor launch. See [WINDOWS-SANDBOX-PROTOTYPE.md](WINDOWS-SANDBOX-PROTOTYPE.md).

## Process and output controls

- Every production subprocess uses discrete arguments and `shell: false`. Windows helpers use absolute paths under the validated system root.
  Windows Pi discovery applies `PATH`/`PATHEXT` rules in controller code. Pioneer reads a bounded recognized npm `pi.cmd` shim without executing it.
  It verifies the target against the installed package manifest's `pi` entry, then launches it with Pioneer's absolute Node executable. Unrecognized batch launchers fail closed.
- Git-target reviews grant Pi no shell on macOS or Windows. The controller resolves Git canonically and allows only `status`, `diff`, `show`, and `rev-parse`.
  It disables hooks, pager, editor, external-diff, credential helpers, LFS filters, and `file`/`ext` protocols. Empty-tree attributes prevent execution of worktree `.gitattributes` filters.
  It rejects info attributes, alternate object stores, and symlinked `.git`. Normal Git directories must stay within `--source`, which must be the repository root.
  Refs and object names undergo validation. Each command has a 256 KiB cap; assembled context has a 1 MiB cap.
  Working-tree comparisons use `HEAD`, or the empty tree for unborn `HEAD`. The prompt labels repository output as untrusted.
  Unknown Git-target prompts fail closed. Work logs record target kinds and exclude inferred refs.
- Review RPC buffers are limited to a cumulative 20 MiB by default and 64 MiB maximum; stderr retains only the final 64 KiB. The collector counts raw stdout bytes before JSON decoding and reports stable `[REVIEW_RPC_OUTPUT_LIMIT]` diagnostics plus bounded byte metadata.
- Pioneer validates eval executables before creating sandbox artifacts. Bare names use sanitized `PATH`; relative paths use the validated run directory.
  Symlink launchers receive only exact lexical/canonical read grants. `/usr/bin/env` shebang checks read bounded prefixes and follow canonical interpreters within cycle/depth limits.
  Capture uses a separate native process group, close-based completion, and bounded pipe-close grace. Timeout and interruption terminate the group.
  Partial output has limits of 4 MiB stdout and 64 KiB stderr. File-streaming options use absent mode-`0600` targets outside all actor grants.
  Pioneer opens output files without following links and caps each at 1 GiB. Timeout, interruption, spawn, shebang, containment, and output-limit failures return stable nonzero diagnostics.
- Review work logs are mode `0600` on macOS and Linux. Default Windows logs use the per-user `%LOCALAPPDATA%` directory ACL; a custom Windows target inherits its existing parent directory ACL, which Pioneer cannot validate, so a parent private to the current user is a caller precondition. Logs are synchronously written after every JSONL record, synced by a dirty-log timer within one second and again on close, limited to 16 MiB per run, and fail the review after writing an explicit truncation record at the bound. A worker thread refreshes each private nonce-backed active lease independently of the controller event loop, and the marker carries the owner's OS process-start identity. A stale-looking lease is preserved when both its PID and process identity still match, handling suspension and clock steps without treating PID liveness alone as ownership; legacy markers and temporarily unavailable identity lookups receive one bounded renewal interval. Abandoned leases expire after crashes or PID reuse and are reclaimed by both creation-time and close-time retention. Both passes complete their bounded critical section synchronously under a private cross-process lock whose PID, nonce, and OS process-start identity are atomically published. Windows derives both owner and inspector identity from the same OS process-start timestamp and uses a narrow millisecond-scale hashed window to absorb clock-source rounding; Linux uses kernel boot/start ticks, and macOS hashes a C-locale UTC start time. Suspension preserves identity while PID reuse changes it, and release verifies the exact owner record before unlinking. A closer renews its log lease until it owns that lock; its pass excludes its finishing target, tolerates concurrently vanished candidates, and orders inactive candidates by last write time while pruning toward the newest 100 total. Pioneer does not rotate custom targets outside that reserved naming pattern.
- Readiness output is limited to 64 KiB per stream.
- Reviews default to a 15-minute timeout; eval actors default to five minutes.
- Cleanup runs even after failure or timeout.

## Package updates

Pioneer checks only `@rock3r/pioneer` in the public npm registry. It uses fixed npm arguments, bounded output, and a five-second timeout.

Pioneer runs npm with its current Node interpreter. It resolves npm from that distribution or a fixed system package-manager path. It ignores caller `PATH`, runs in a private empty directory, and supplies null user/global npm configuration paths with a constrained environment.

Repository/home npm configuration and ambient npm tokens cannot affect checks or installation. Global installs derive their prefix from Pioneer's package location. They never take it from npm configuration.

Background checks run alongside the requested command and cannot affect its result. Pioneer caches successful and failed check times for 24 hours. The cache contains only a timestamp and public package version.

`pioneer update` always performs a fresh version check and never changes an installation without confirmation or `--yes`. If requested, it retrieves bounded GitHub release notes for the selected public version before delegating the global install to npm as discrete argv. Neither update path reads Pi configuration or forwards credentials.

## Residual risks

- Review skills execute inside the sandbox and can still alter the review, exfiltrate any granted content, or consume provider quota. Deep review actors disable skill discovery entirely.
- Deep review actors disable skill discovery, generic built-in tools, and unrestricted `bash`. They load the enabled user extension snapshot, Pioneer's bundled inspection extension, and explicitly pinned provider extensions selected from a trusted capability profile outside the reviewed source tree; each selected extension must declare a SHA-256 content digest verified before launch. Actors use `public` networking, never inherit `GITHUB_TOKEN`, and receive packet/candidate data only through typed extension tools bounded by the controller.
- `full` review networking intentionally permits proxy access to LAN and loopback services.
- `eval run --allow-loopback` gives the untrusted actor raw access to the named host loopback ports; the listening service must tolerate hostile input.
- `eval run --env` values are visible to the actor and its tools, and `--pi-extension` code runs with its tools enabled. Pass neither a credential nor an untrusted extension.
- A writable reference path is a real host write capability. Grant it sparingly.
- Proxy-unaware tools cannot use Linux networking.
- Windows reviews have no OS filesystem boundary.
- On macOS and Windows, a descendant that deliberately escapes the expected process-group behavior may retain resources until the bounded containment grace expires; Pioneer reports containment failure and destroys its capture streams, but cannot retroactively revoke resources outside the native sandbox. Linux is not exposed to this because the actor's PID namespace is destroyed with it.
- Controller-collected Git context is untrusted repository text. A malicious repo can still place misleading diffs or status lines in the review prompt.
- Ordinary reviews return model prose without schema validation of findings. Deep review uses a separate versioned result contract for council workflows.

Report suspected sandbox escapes or credential disclosure privately to the maintainers before publishing details.
