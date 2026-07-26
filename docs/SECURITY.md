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

Review actors receive only the controller-selected runtime variables, Pi's isolated `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR`, proxy variables, and minimal locale/path settings. Eval actors receive an even narrower broker environment. A mandatory eval probe verifies that a controller-only secret is absent.

Neither debug output nor errors should contain Pi credentials, proxy tokens, prompts, or full environment dumps.

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
- Readiness output is limited to 64 KiB per stream.
- Reviews default to a 15-minute timeout; eval actors default to five minutes.
- Cleanup runs even after failure or timeout.

## Residual risks

- Review skills execute inside the sandbox and can still alter the review, exfiltrate any granted content through permitted networking, or write to explicit writable grants. Optional Pi extensions are not discovered by Pioneer actors.
- `full` review networking intentionally permits proxy access to LAN and loopback services.
- A writable reference path is a real host write capability. Grant it sparingly.
- Proxy-unaware tools cannot use Linux networking.
- Windows reviews have no OS filesystem boundary.
- The current result is free-form model output, not a schema-validated finding set.

Report suspected sandbox escapes or credential disclosure privately to the maintainers before publishing details.
