# Security model

## Goal

Pioneer treats the reviewed repository, Pi tools, model output, and eval actors as untrusted. On macOS and Linux it aims to let Pi inspect explicitly granted material and use a private scratch directory without granting ambient access to the operator's files or direct network stack.

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
- an optional `--report` target is controller-owned, create-only, and never granted to the actor; it must be absolute, absent, and outside every actor-visible grant; Pioneer exclusively reserves it with a private random ownership marker bound to the controller's OS process-start identity plus a randomly named controller-owned sibling reservation link before announcing the path, so untrusted report text cannot impersonate an active reservation, live sidecars are protected before target-link creation, incomplete markers receive a one-minute setup grace, abandoned reservations are reclaimable after controller exit, inactive post-publication siblings are reclaimed by later default-report retention, and an orphaned link cannot block reuse of an absent target; Pioneer publishes through the owned reservation inode while a separate random publication lease protects it from concurrent retention, restores the marker after a failed write, treats close failure after successful sync and identity validation as cleanup without rewriting the report, and atomically quarantines each cleanup candidate before verifying and removing only the owned inode, so an unowned replacement is atomically moved to a fresh visible non-retained sibling before create-only restoration and Pioneer never deletes the preserved name; crash-left release quarantines receive a one-minute setup grace and are then reclaimed by default-report retention;
- every review work log is controller-owned, create-only, and never granted to the actor; an explicit `--work-log` target must be absolute, absent, free of control characters, and outside every actor-visible grant;
- on macOS and Linux, every folder above an explicit `--report` or `--work-log` target, or above the nearest existing folder of a target Pioneer will create, must be owned by the caller or root and must not be writable by other users unless it is sticky and the entry below it is the caller's; otherwise another user could rename a folder and put a link into an actor grant in its place after validation;
- a writable grant may not overlap the source or a read-only grant;
- filesystem roots and the user's home directory are rejected as grants;
- grant paths must exist, be directories, and not themselves be symbolic links;
- all accepted paths are canonicalized before policy construction.

### Native resume archive privacy

Pioneer stores native resume archives in private per-user application-data directories. POSIX directories use mode `0700`, and manifests use `0600`. Windows relies on the per-user application-data access control list (ACL). XDG and Windows application-data overrides must be absolute.

Before archive creation, archive loading, or default report preparation, Pioneer validates both the lexical and canonical application-data ownership chains. On POSIX, every directory must belong to the caller or root. Pioneer rejects replaceable group- or world-writable ancestors. It allows trusted sticky directories only when they protect a caller-owned entry. It then makes the Pioneer application directory private.

### Archive and output boundaries

Before creating or changing permissions on an archive root, Pioneer canonicalizes its prospective location. It rejects overlap with the source, actor-visible read/write grants, or selected Pi-home snapshot source. Creation and every load recheck the canonical root against those stored boundaries.

Pioneer also checks default report and work-log targets, including every directory their preparation creates or changes, for overlap in both containment directions. It preflights both defaults before either can change storage. During preparation, it revalidates each actual randomized target.

Resume requires explicit and derived default outputs to stay outside the entire private resume store. This prevents one token's outputs from corrupting or exposing another archive. Pioneer canonicalizes the selected Pi-home source before fixing its identity in resumable scope. Retargeting a symlink therefore cannot silently change the selected credentials or configuration.

The token identifies an archive. Filesystem permissions control access to it.

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

For evals, the actor run directory is the only persistent writable tree. The work log and any `--stdout-file` or `--stderr-file` target follow the same folder-chain rule as review outputs, so only the caller or root can change a folder above them. Another process running as the caller can still modify those files directly, which no path check prevents. The run directory and caller-supplied runtime reads must be narrow, existing canonical paths and must not overlap. The selected Pi home may not overlap the run directory or any runtime-read grant. Controller-derived executable reads already covered by the writable run tree are omitted rather than widened into redundant grants. Writable protected-system roots and their descendants, plus broad filesystem, sensitive-configuration, home, temporary, and variable-data roots and their canonical platform aliases, are rejected before sandbox construction; narrow read-only system runtimes and disposable temporary descendants remain available where execution requires them. A validated Pi package root may not contain or be contained by the writable run tree. Eval preparation canonicalizes the proposed output parent, requires it to remain outside the source skill, and revalidates the created destination before writing descendants. It accepts `skill_name` only as one non-empty, non-dot, cross-platform-safe path component within the 255-byte filename limit, including rejection of Windows reserved device names, invalid characters, and trailing dots or spaces, then verifies destination containment before copying. Actor-visible eval trees may not contain symlinks. Before it creates output, eval preparation also rejects fixture paths and contents that leak the expected finding with `[EVAL_FIXTURE_LEAK]`; see [EVALS.md](EVALS.md) for the exact rules. Every `files[]` entry must be a regular file of at most 64 MiB. Pioneer opens each fixture without following a final symbolic link and without blocking on a FIFO, then checks the type and size with `fstat` on that descriptor. Directories and special files are rejected, and a larger file fails with `[EVAL_FIXTURE_TOO_LARGE]`. The content scan streams from the same descriptor with bounded memory. Pioneer then closes it and records the file's device, inode, size, modification and change times, and permission bits, so a large battery holds at most one fixture descriptor at a time. Each staged copy reopens the file, refuses it with `[EVAL_FIXTURE_CHANGED]` when that identity differs before or after the copy, and scans every byte again while it writes the copy. Validation therefore applies to the bytes that reach `fixtures/`, even when the source path is replaced during preparation. The size is checked again while streaming, so a file that grows past the limit also fails. When a staged copy fails that second scan, Pioneer removes the copy and stops, but it leaves the partly prepared output directory in place; do not use that output.

## Pi configuration and credentials

The controller copies the selected Pi agent directory into a private run area and sets `PI_CODING_AGENT_DIR` to the copy. It never mounts the real directory into the actor. Eval validation rejects a real Pi home that overlaps any actor grant. Eval copies and controller launch/probe files live in a canonical private temporary tree outside the persistent actor run. Its base defaults to the platform's short shared temporary directory. A caller-supplied `controllerScratchBase`, on either an eval run or a review request, is canonicalized and refused when it is missing, not a directory, a broad or protected system location, or too short of room for the proxy bridge socket, because the actor's write grants follow it. It is also refused when another local principal could tamper with it, meaning a base this user does not own or one that it, or any ancestor above it, leaves writable to other users without the sticky bit — the same ownership-chain walk the review application-data parent already uses, because a private directory under a replaceable parent can be renamed away and substituted; the default `/tmp` at mode 1777 satisfies that. A supplied base is also refused when it sits inside a path the actor is granted, because the controller would otherwise create and remove its scratch through a mount promised read-only and hand the sandbox overlapping paths; a base that merely shares an ancestor with a grant is accepted, since the scratch it generates is a sibling. Both the eval and review scratch directories are then adopted without following a symlink, so a directory replaced between creation and use is rejected rather than receiving the Pi configuration snapshot and the recursive cleanup that follows it. The selected eval Pi configuration is copied into an ephemeral isolated `agentDir`. That snapshot directory is writable so Pi can create lock directories beside `auth.json` and `settings.json`; the real Pi home is never mounted, and the snapshot is deleted on every exit path. Only the isolated home/tmp scratch plus that snapshot agent directory are writable. An outer signal scope guarantees that the entire temporary tree is removed even when interruption occurs before actor launch.

The snapshot is positive by default. It copies only root `auth.json`, `models.json`, `models-store.json`, `settings.json`, and `AGENTS.md`; review snapshots additionally traverse `skills/`, while eval snapshots exclude it. Traversal of `skills/` skips `node_modules/`, `.git/`, `.npm/`, `.cache/`, transient directories, and log files. Root-level `npm/`, `git/`, and unknown paths are outside the allowlist, while valid skill directories such as `skills/git/` and `skills/npm/` remain visible. Review callers can add repeated `--pi-home-include RELATIVE_PATH` exact paths to select otherwise skipped `node_modules/`, `.git/`, or unknown files/directories. Paths are relative to the selected source Pi home; globs, negation, configuration files, and eval opt-ins are not supported.

The hard exclusions that cannot be overridden are `sessions/`, `logs/`, `.npm/`, `.cache/`, `tmp/`, `.tmp/`, `temp/`, and files ending in `.log` (including debug logs), at any depth. One exception applies inside an installed dependency: below a `node_modules/` segment, `sessions/`, `logs/`, `tmp/`, `.tmp/`, and `temp/` are package source rather than Pi runtime storage, so an explicitly included dependency keeps them. `.npm/`, `.cache/`, and `.log` files stay excluded there too. A session directory configured through `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting is also a hard exclusion when it lies inside the Pi home, including inside a dependency. A leading `~` in that setting expands against the home directory of the environment Pi runs with. Pi resolves a relative session directory against its own working directory, which Pioneer cannot know, so a relative value fails with `PI_SESSION_DIR_RELATIVE`. Pioneer otherwise normalizes the value as Pi does, including `file://` URLs and Windows Git Bash, Cygwin, and WSL drive paths. When the root `sessions/`, `logs/`, or a root `.log` file is a link, its canonical target inside the Pi home is excluded too. Pi session files are also excluded by content, wherever they are, as described in [Session history outside known locations](#session-history-outside-known-locations). These exclusions also apply on filesystems that do not report directory entry types, such as some FUSE and network filesystems; Pioneer then reads each entry's type with `lstat`. Exclusion matching follows platform filename semantics: macOS and Windows fold case, including for explicit includes, while Linux remains case-sensitive. The controller deduplicates overlapping selections, rejects destination collisions, and counts only selected entries and file bytes toward the 500,000-entry and 1 GiB backstops. Opting in large or machine-specific package trees increases review time, storage, and portability risk.

The copy rejects special files, broken links, and links escaping the Pi home. An internal symlink is preserved only when its resolved target is also selected; otherwise the snapshot fails with a relative target and an opt-in diagnostic where policy permits. This prevents a selected skill from silently pulling an excluded package store into the snapshot. Symlinked Pi launcher names directly under an unselected `bin/` tree are not copied; Pioneer launches the separately resolved host Pi executable.

The copy is bounded to 500,000 entries and 1 GiB after exclusions. Provider authentication should therefore be configured in Pi's agent directory, normally through `pi` and `/login`. Host API-key environment variables are intentionally not copied wholesale into sandboxed runs.

When Pi reports no configured models, readiness checks only filesystem access permissions on the agent directory and the known configuration filenames `auth.json`, `models-store.json`, and `settings.json`. It never opens or reads those files. A permission denial is reported as an outer-terminal sandbox problem rather than misleading the user to reconfigure Pi.

When Pi reports that `models.json` could not be loaded, Pioneer rejects the entire catalog even if Pi also prints cached or built-in models. The stable diagnostic does not repeat Pi's raw provider-specific error text and directs callers to rerun Pioneer outside an outer sandbox before editing configuration, because a sandbox can prevent Pi from creating required configuration lock files.

Some policy sandboxes, including macOS Seatbelt configurations, allow metadata checks while withholding file contents. When Pi reports no models in such an environment, a recognized outer-agent sandbox indicator triggers the same conservative diagnosis. Only the indicator's variable name is reported, never its value. Callers can set `PIONEER_OUTER_SANDBOX=1` when their sandbox is not recognized automatically.

## Session history outside known locations

Pioneer cannot find every Pi session directory by location, so both snapshots also exclude Pi session files by content.

Pi takes `sessionDir` from merged global and project settings. The project file is `.pi/settings.json` in the directory where the operator starts Pi. Pi reads it for session lookup before it resolves project trust, and a project value overrides the global one. The operator can also pass `--session-dir`. Pioneer sees only `PI_CODING_AGENT_SESSION_DIR` and the global `settings.json`. It cannot know which other projects the operator has used Pi in, or which flags they passed. So an operator's project-level `sessionDir` can point at a directory inside an enabled extension root, a selected `node_modules` tree, `skills/`, or a `--pi-home-include` path. Without a content check, that real history would reach the review snapshot. This was confirmed against Pi 1.2.0. A script used Pi's own `SettingsManager` and `SessionManager` to resolve a project-level `sessionDir` inside an extension directory and a `--pi-home-include` path, and to write a session there. Without the content check, both snapshots copied the session file. The full Pi CLI was not run.

Pi stores sessions only as `.jsonl` files. It treats the first parseable line as the header, and it skips blank, malformed, and falsy lines to find it. Pioneer applies the same rule to every regular file whose name ends in `.jsonl` in any letter case. For a link, Pioneer checks both the link name and the canonical target name. A file with more than one hard link is checked whatever its name, because another of its names can end in `.jsonl`. A file is session history when its header is a JSON object with `type` set to `"session"`. Pi also requires a string `id`, so Pioneer's rule is broader and fails closed. Pioneer reads at most about 1 MiB to find the header. A file with no header in that range is treated as history. Pi 1.2.0 uses the same 1 MiB limit when it lists sessions.

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

Residual limits: Pioneer limits each file's header scan to about 1 MiB. Each snapshot also limits the total of its header scans to 500,000 opened files and 1 GiB read. Every scan counts, including scans of files that the snapshot then skips as history. In the Pi-home snapshot this also covers the checks of link targets and of each copy. When a total passes its limit, the snapshot stops with `PI_HOME_SNAPSHOT_LIMIT` or `PI_EXTENSION_SNAPSHOT_LIMIT`. These scan limits are separate from the entry and byte limits for selected content. The extension snapshot applies them to each staging call. An eval that stages user, explicit, and `--pi-extension` code in three calls can therefore read up to 1 GiB in each call. Within these limits, many `.jsonl` files that start with long runs of blank or malformed lines can still make snapshot preparation slow. A session file renamed away from `.jsonl`, or edited so that its first parseable line is no longer a session header, is not detected. Pi would not list such a file as a session either. Operators should still keep session storage outside extension, dependency, and skill directories.

## Environment policy

Pi readiness probes receive an allowlist of runtime, home-directory, certificate, temporary-directory, and `PI_CODING_AGENT_DIR` variables. Provider secrets, coding-agent control state, and other ambient host variables are not inherited. Pi authentication and provider configuration should come from the selected Pi agent directory.

Review actors receive only the controller-selected runtime variables, Pi's isolated `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR`, proxy variables, and minimal locale/path settings. This narrow environment applies on Windows too, even though Windows review filesystem isolation remains instruction-only. Eval actors receive an even narrower broker environment. A mandatory eval probe verifies that a controller-only secret is absent.

Neither debug output nor errors should contain Pi credentials, proxy tokens, prompts, or full environment dumps. Work logs contain controller lifecycle records and a field allowlist of Pi RPC metadata. They omit prompts, assistant text and thinking, message bodies, tool arguments and results, queue contents, extension paths, proxy values, environment values, and provider diagnostic text. Provider-controlled response and assistant-error text is represented to callers only by stable state, presence, count, and byte metadata. When Pi exits early or nonzero, or a readiness probe fails, the error adds a summary of stderr. The summary contains only values from fixed allowlists: the error class, a known Node error code and syscall, the npm package named in the stack when it is one of the extension packages that the controller staged, and the diagnostic codes that Pioneer's own adapter writes, for example `error=Error; code=EPERM; syscall=spawn; package=pi-subagents`. It never contains stderr message text or paths, because stderr is untrusted and can hold credentials that no pattern redaction recognizes. Readiness metadata and controller-owned diagnostic fields that must remain visible are whitespace-normalized, capped at 500 characters, and redacted for common authorization, authenticated-URL, signed-URL query, cookie, session, connection-string, passphrase, token, key, password, and secret forms. Requested-model errors sanitize and cap the untrusted requested name separately, then preserve the complete catalog assembled from validated provider and model fields.

## OAuth refresh in native reviews and evals

The broker serializes up to eight pending requests instead of rejecting overlapping refreshes. Source OAuth storage must be a regular `auth.json` file: symlinks are rejected because Pi names locks from the lexical credential path. Only snapshot OAuth providers are intercepted; other private-store updates retain Pi's ordinary behavior.

Native reviews, deep reviews, and evals on a trusted Pi package that can host the auth adapter broker OAuth refreshes, including built-in-only reviews and evals. A private authenticated endpoint accepts only a provider name from the original snapshot's OAuth providers. It accepts no credentials, update payloads, or filesystem paths from the review actor. The proxy pins the broker's randomized hostname to its exact loopback port; other destinations retain the requested public/full policy. Concurrent requests within one broker are bounded, and Pi's own source `auth.json` lock serializes refreshes across Pioneer processes and ordinary Pi.

While holding that lock, the controller copies current configuration into a separate worker scratch tree, replaces its credential file with only the requested provider's current credential, and runs installed Pi's provider authentication in a native sandbox. Before extension initialization, the worker captures that credential in Pi's in-memory auth store. Its result comes from that store's authentication API, not from subsequent `auth.json` file contents. The worker initializes the read-only extension snapshot but receives no model, prompt, session, reviewed source, review scratch, or original Pi-home grant. User extension code still never runs in the controller. The controller reads the separate worker result through a file handle opened before launch, so worker-created symlinks and replaced parents cannot redirect that read. It validates a bounded OAuth record and merges only the requested provider into the locked source credential file. Review-agent credential changes are never copied back.

The authentication worker is a separate trust domain from the review process. Operator-enabled provider code is trusted to produce its provider's credentials, just as in normal Pi. Its native sandbox limits filesystem and network authority; it does not mutually isolate JavaScript extensions within the authentication process. An intentionally malicious installed extension that subverts the authentication API is outside that guarantee. Neither a model response nor reviewed repository content is evaluated by this worker.

The source write precedes temporary cleanup, and an already-written worker rotation is preserved even if a later worker operation fails. Broker shutdown waits for active refresh persistence before removing its private snapshots. Provider diagnostics and credentials are never returned in errors or work logs. An abrupt process or machine failure between remote rotation and local persistence remains possible, as it does in ordinary Pi, and may require reauthentication. This mechanism does not recover a refresh token already invalidated by an earlier run. An eval on that package uses the same broker and the public network policy, including when the Pi command passes `--no-extensions` or `-ne`. A refresh is written to the source credential file before the private snapshot is removed. An eval whose snapshot contains OAuth credentials fails before launch when the Pi package cannot host the auth adapter. It does not continue with only the isolated credential copy.

## Network policy

All sandboxed network access is proxy-mediated and authenticated with a per-run random token.

| Mode | Destinations | Intended use |
| --- | --- | --- |
| `full` | Public internet, LAN, and loopback through the proxy | Default review mode; allows probing a local deployment |
| `public` | Globally routable destinations only | Reviews that do not need local services; all evals, apart from exact `--allow-loopback` ports |
| `none` | No proxy and no outbound grant | Rejected for reviews because Pi cannot reach its configured model provider |

Public-only resolution rejects local suffixes and non-global IPv4/IPv6 ranges. It requires every DNS answer to be public, then connects to a selected validated address rather than resolving again. This closes the normal DNS-rebinding window.

On Linux, the actor has a private network namespace. A small Node supervisor exposes only a loopback port relayed to one mode-0600 Unix socket connected to the parent proxy. Raw host, LAN, or public TCP is unavailable; tools must honor standard HTTP(S) proxy variables.

`eval run --allow-loopback 127.0.0.1:PORT` is an explicit operator exception for skills that drive a local desktop app through a local bridge. It opens raw TCP to exactly the named host loopback ports: a Seatbelt outbound rule per port on macOS, and on Linux a controller relay from a dedicated mode-0600 Unix socket to that one host port, surfaced inside the namespace by the supervisor. Ports are exact integers, hosts are IPv4 loopback only, and the actor gets `NO_PROXY=127.0.0.1,localhost`. The proxy itself keeps refusing loopback. The mandatory probe runs under the same policy against a listener outside the allow list, so a widened rule would still fail closed. Treat any service on an allowed port as reachable by the untrusted actor.

## Platform enforcement

### macOS

The controller runs `/usr/bin/sandbox-exec` with a generated Seatbelt profile starting from `deny default`. Read/write grants and ancestor metadata traversal are explicit. `/dev/null` may be opened for reading and writing because process spawning with ignored stdio and Git require it; it discards writes and reads as empty. Network access is limited to the authenticated loopback proxy port and any eval `--allow-loopback` ports.

macOS uses the legacy `sandbox-exec` interface, for which Apple provides no public drop-in replacement for dynamically sandboxing arbitrary CLI processes. Mandatory live smoke tests detect removal or semantic drift.

### Linux

Bubblewrap creates an empty tmpfs root, explicit read-only and writable binds, new user/PID/network/IPC/UTS namespaces, private `/proc` and `/dev`, parent-death behavior, and no capabilities. The detached controller capture process owns the dedicated session/process group used for containment and termination. Because Bubblewrap is PID 1 of the actor's PID namespace, the kernel destroys every remaining process in that namespace when the actor exits, so a descendant holding inherited pipes cannot outlive the run. Linux process containment is therefore structural rather than detected, and `[EVAL_PROCESS_CONTAINMENT_FAILED]` is not reachable there. Every Bubblewrap option Pioneer compiles has been available since bubblewrap 0.2.0, so Pioneer does not probe for a version. Ubuntu systems that restrict unprivileged user namespaces can use the narrow root-owned Bubblewrap copy and AppArmor profile described in [EVALS.md](EVALS.md).

### Windows

Review isolation is not enforced. The caller must explicitly pass `--allow-unsandboxed-windows`; the CLI returns a warning and relies on instructions to Pi. Strict eval execution fails closed before actor launch. See [WINDOWS-SANDBOX-PROTOTYPE.md](WINDOWS-SANDBOX-PROTOTYPE.md).

## Process and output controls

- Every production subprocess uses discrete argv with `shell: false`; Windows controller helpers use absolute paths under the validated system root rather than current-directory or `PATH` lookup. Windows Pi discovery applies `PATH`/`PATHEXT` semantics in controller code. Pioneer never executes an npm `pi.cmd`: it reads a bounded recognized generated shim, verifies the extracted target against the exact installed Pi package manifest and declared `pi` bin, then launches that canonical target with Pioneer's absolute Node executable and an argument array. Unrecognized batch launchers fail closed.
- Git-target reviews never grant Pi a shell on macOS or Windows. The controller resolves Git canonically, runs only `status`, `diff`, `show`, and `rev-parse` with disabled hooks, pager, editor, external-diff, credential helpers, LFS filters, and `file`/`ext` protocols, reads attributes from the empty tree so worktree `.gitattributes` filters cannot execute, rejects info attributes, alternate object stores, and a symbolic-link `.git`, keeps a normal repository Git directory inside `--source`, validates refs and object names, and bounds each command to 256 KiB and the assembled context to 1 MiB. Working-tree collection diffs against `HEAD`, or the empty tree when `HEAD` is unborn. Repository output is injected into the prompt as untrusted text. `--source` must be the repository root. Unrecognized Git-target prompts fail closed instead of substituting the working tree. Work-log Git metadata records target kinds only, not inferred refs.
- Review RPC buffers are limited to a cumulative 20 MiB by default and 64 MiB maximum; stderr retains only the final 64 KiB. The collector counts raw stdout bytes before JSON decoding and reports stable `[REVIEW_RPC_OUTPUT_LIMIT]` diagnostics plus bounded byte metadata.
- Eval actors are resolved and validated before sandbox artifacts are created. Bare executable lookup uses only the sanitized selected `PATH`; relative paths are anchored to the validated run directory; symlink launchers grant only their exact lexical path and canonical target. `/usr/bin/env` shebang inspection reads a bounded prefix and follows canonical interpreter paths only through a bounded, cycle-checked chain. Eval capture uses a distinct native process group, close-based completion, a bounded pipe-close grace period, and group termination on timeout or interruption. Partial output is retained within 4 MiB stdout and 64 KiB stderr limits. `--stdout-file` and `--stderr-file` stream a stream instead to a create-only, mode `0600` file outside every actor grant, which Pioneer opens without following links and bounds at 1 GiB, with stable nonzero diagnostics for timeout, interruption, spawn, shebang-resolution, containment, and output-limit failures.
- Review work logs are mode `0600` on macOS and Linux. Default Windows logs use the per-user `%LOCALAPPDATA%` directory ACL; a custom Windows target inherits its existing parent directory ACL, which Pioneer cannot validate, so a parent private to the current user is a caller precondition. Logs are synchronously written after every JSONL record, synced by a dirty-log timer within one second and again on close, limited to 16 MiB per run, and fail the review after writing an explicit truncation record at the bound. A worker thread refreshes each private nonce-backed active lease independently of the controller event loop, and the marker carries the owner's OS process-start identity. A stale-looking lease is preserved when both its PID and process identity still match, handling suspension and clock steps without treating PID liveness alone as ownership; legacy markers and temporarily unavailable identity lookups receive one bounded renewal interval. Abandoned leases expire after crashes or PID reuse and are reclaimed by both creation-time and close-time retention. Both passes complete their bounded critical section synchronously under a private cross-process lock whose PID, nonce, and OS process-start identity are atomically published. Windows derives both owner and inspector identity from the same OS process-start timestamp and uses a narrow millisecond-scale hashed window to absorb clock-source rounding; Linux uses kernel boot/start ticks, and macOS hashes a C-locale UTC start time. Suspension preserves identity while PID reuse changes it, and release verifies the exact owner record before unlinking. A closer renews its log lease until it owns that lock; its pass excludes its finishing target, tolerates concurrently vanished candidates, and orders inactive candidates by last write time while pruning toward the newest 100 total. Pioneer does not rotate custom targets outside that reserved naming pattern.
- Readiness output is limited to 64 KiB per stream.
- Reviews default to a 15-minute timeout; eval actors default to five minutes.
- Cleanup runs even after failure or timeout.

## Package updates

Pioneer checks only the fixed `@rock3r/pioneer` npm package name and public npm registry, with fixed npm arguments, bounded output, and a five-second timeout. It invokes npm's CLI with the running Node interpreter and the CLI from that distribution or a fixed system package-manager path rather than the caller's `PATH`, runs from a private empty directory, and supplies null user/global npm config paths with a constrained cross-platform environment. Repository-local and home-directory npm configuration, and ambient npm tokens, therefore cannot affect either the check or install. Global installs preserve the prefix structurally derived from Pioneer's own package location, never from npm configuration. Normal checks are best-effort: they run in parallel with the requested command, do not affect its result, and cache both successful and failed check times for 24 hours. The cache contains only a timestamp and the public package version.

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
- The current free-form review result is model prose, not a schema-validated finding set. Deep review adds a separate versioned result contract for council workflows.

Report suspected sandbox escapes or credential disclosure privately to the maintainers before publishing details.
