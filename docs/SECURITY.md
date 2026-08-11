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
- the private scratch directory and repeated `--allow-write` grants are writable;
- an optional `--report` target is controller-owned, create-only, and never granted to the actor; it must be absolute, absent, and outside every actor-visible grant;
- every review work log is controller-owned, create-only, and never granted to the actor; an explicit `--work-log` target must be absolute, absent, and outside every actor-visible grant;
- a writable grant may not overlap the source or a read-only grant;
- filesystem roots and the user's home directory are rejected as grants;
- grant paths must exist, be directories, and not themselves be symbolic links;
- all accepted paths are canonicalized before policy construction.

For evals, the actor run directory is the only persistent writable tree. Runtime reads must be narrow, existing canonical paths; broad roots such as `/`, `/Users`, `/home`, `/tmp`, `/var`, and the user's home directory are rejected. Actor-visible eval trees may not contain symlinks.

## Pi configuration and credentials

The controller copies the selected Pi agent directory into the private run area and sets `PI_CODING_AGENT_DIR` to the copy. It never mounts the real directory into the actor.

Always excluded:

- sessions;
- logs and `*.log` files;
- `.npm` and `.cache` directories;
- root-level `tmp`, `.tmp`, and `temp` trees.

Pi's managed `npm/`, `git/`, and nested `node_modules/` content is retained because configured review skills may refer to package resources. Pioneer nevertheless starts review and eval actors with extension discovery disabled; review completion never depends on an optional extension.

Eval snapshots additionally exclude `skills`. Review snapshots retain configured skills because they can be relevant to code review.

The copy rejects special files, broken links, and links escaping the Pi home. Symlinked Pi launcher names directly under `bin/` are omitted instead: Pioneer launches the separately resolved host Pi executable, so copying those launchers is unnecessary and following an external managed-runtime link would weaken the snapshot boundary. Other agent-bin helpers remain subject to the normal link rules.

The copy is bounded to 500,000 entries and 1 GiB after exclusions. Provider authentication should therefore be configured in Pi's agent directory, normally through `pi` and `/login`. Host API-key environment variables are intentionally not copied wholesale into sandboxed runs.

When Pi reports no configured models, readiness checks only filesystem access permissions on the agent directory and the known configuration filenames `auth.json`, `models-store.json`, and `settings.json`. It never opens or reads those files. A permission denial is reported as an outer-terminal sandbox problem rather than misleading the user to reconfigure Pi.

When Pi reports that `models.json` could not be loaded, Pioneer rejects the entire catalog even if Pi also prints cached or built-in models. The stable diagnostic does not repeat Pi's raw provider-specific error text.

Some policy sandboxes, including macOS Seatbelt configurations, allow metadata checks while withholding file contents. When Pi reports no models in such an environment, a recognized outer-agent sandbox indicator triggers the same conservative diagnosis. Only the indicator's variable name is reported, never its value. Callers can set `PIONEER_OUTER_SANDBOX=1` when their sandbox is not recognized automatically.

## Environment policy

Pi readiness probes receive an allowlist of runtime, home-directory, certificate, temporary-directory, and `PI_CODING_AGENT_DIR` variables. Provider secrets, coding-agent control state, and other ambient host variables are not inherited. Pi authentication and provider configuration should come from the selected Pi agent directory.

Review actors receive only the controller-selected runtime variables, Pi's isolated `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR`, proxy variables, and minimal locale/path settings. This narrow environment applies on Windows too, even though Windows review filesystem isolation remains instruction-only. Eval actors receive an even narrower broker environment. A mandatory eval probe verifies that a controller-only secret is absent.

Neither debug output nor errors should contain Pi credentials, proxy tokens, prompts, or full environment dumps. Work logs contain controller lifecycle records and a field allowlist of Pi RPC metadata. They omit prompts, assistant text and thinking, message bodies, tool arguments and results, queue contents, extension paths, proxy values, and environment values. Provider diagnostics are whitespace-normalized, capped at 500 characters, and redacted for common authorization, token, key, password, and secret forms before persistence.

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

Bubblewrap creates an empty tmpfs root, explicit read-only and writable binds, new user/PID/network/IPC/UTS namespaces, private `/proc` and `/dev`, a new session, parent-death behavior, and no capabilities. Ubuntu systems that restrict unprivileged user namespaces can use the narrow root-owned Bubblewrap copy and AppArmor profile described in [EVALS.md](EVALS.md).

### Windows

Review isolation is not enforced. The caller must explicitly pass `--allow-unsandboxed-windows`; the CLI returns a warning and relies on instructions to Pi. Strict eval execution fails closed before actor launch. See [WINDOWS-SANDBOX-PROTOTYPE.md](WINDOWS-SANDBOX-PROTOTYPE.md).

## Process and output controls

- Every subprocess uses discrete argv with `shell: false`.
- Review RPC buffers are limited to 4 MiB and stderr retains only the final 64 KiB.
- Review work logs are mode `0600` on macOS and Linux and use the per-user `%LOCALAPPDATA%` ACL on Windows. They are synchronously written after every JSONL record, synced by a dirty-log timer within one second and again on close, limited to 16 MiB per run, and stop with an explicit truncation record at the bound. A worker thread refreshes each private nonce-backed active lease independently of the controller event loop. A stale-looking lease with a live PID receives one bounded renewal interval to handle suspend/resume and clock steps, but PID liveness alone never proves ownership; abandoned leases expire after crashes and are reclaimed by both creation-time and close-time retention. Both passes complete their bounded critical section synchronously under a private cross-process lock whose PID, nonce, and OS process-start identity are atomically published. Windows uses a narrow hashed start-time window to absorb clock-source rounding; Linux uses kernel boot/start ticks, and macOS hashes a C-locale UTC start time. Suspension preserves identity while PID reuse changes it, and release verifies the exact owner record before unlinking. A closer renews its log lease until it owns that lock; its pass excludes its finishing target, tolerates concurrently vanished candidates, and orders inactive candidates by last write time while pruning toward the newest 100 total. Pioneer does not rotate custom targets outside that reserved naming pattern.
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
- The current result is free-form model output, not a schema-validated finding set.

Report suspected sandbox escapes or credential disclosure privately to the maintainers before publishing details.
