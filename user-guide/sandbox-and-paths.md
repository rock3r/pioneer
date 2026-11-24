# Sandbox and path grants

Pioneer treats the review actor as untrusted. On macOS and Linux, Pi can use only the filesystem and network capabilities that Pioneer explicitly grants.

## Default access

| Resource | Access |
| --- | --- |
| `--source` | Read-only |
| Each `--allow-read` path | Read-only |
| Private scratch directory | Read-write |
| Copied run-local Pi agent directory | Read-write |
| Each `--allow-write` path | Read-write |
| Other user files | Unavailable |
| Host credentials and arbitrary environment variables | Not inherited |

Pioneer canonicalizes grants before launch. It rejects source symlinks, grants that overlap with conflicting access, sensitive credential paths in review grants, and unsafe broad eval runtime grants. An explicit writable path is a real host capability, so grant the narrowest directory that meets the request.

Pioneer validates eval commands before creating launch artifacts. It finds bare executable names through its sanitized `PATH` and resolves relative paths below the run directory. Absolute symlink launchers receive exact lexical and canonical read grants. Missing or non-executable targets stop the run.

On timeout or containment failure, Pioneer terminates the native process group. It bounds the wait for inherited output pipes.

The private scratch and copied Pi home are deleted when the review finishes. Use `--report /absolute/path/report.md` when you need Pioneer to preserve the final Markdown report; that does not require giving Pi another writable path.

## Isolated Pi home

Pioneer copies selected content from `PI_CODING_AGENT_DIR` into the private run area. If the variable is unset, it uses `~/.pi/agent`.

The default root allowlist contains `auth.json`, `models.json`, `models-store.json`, `settings.json`, and `AGENTS.md`. Review snapshots also include a sanitized `skills/` tree. Eval snapshots exclude skills.

Skills traversal skips dependency and runtime content such as `node_modules/` and `.git/`. The root allowlist excludes `npm/`, `git/`, and unknown paths. Valid skill directories named `git` or `npm` remain available.

For reviews, repeat `--pi-home-include RELATIVE_PATH` to select exact existing files or directories relative to the Pi home. Use `--pi-home-include=--NAME` for paths beginning with `--`. Includes accept no globs, negation, or configuration files. Evals have no include option.

Hard exclusions remain: `sessions/`, `logs/`, `.npm/`, `.cache/`, `tmp/`, `.tmp/`, `temp/`, and `*.log` paths. macOS and Windows match these names without case sensitivity. Inside included `node_modules/` packages, directories named `sessions/`, `logs/`, `tmp/`, `.tmp/`, or `temp/` contain package source and remain included.

Pioneer copies internal symlinks only when their targets are selected. Broken links, escapes, special files, unselected targets, and ambiguous collisions stop the snapshot.

Both modes cap selected content at 500,000 entries and 1 GiB. Skipped content does not count toward these limits. Large or machine-specific includes increase storage, runtime, and portability risk.

Review and eval actors disable ambient extension discovery. They load staged enabled user extensions through explicit `--extension` paths. Both modes strip extension tools.

Eval snapshots use an external private temporary tree. Pi can write credential lock directories in the isolated `agentDir`. Home/tmp scratch is separate and writable. Pioneer never mounts the source Pi home and removes the temporary tree after the run.

Use `--pi-home /absolute/path` to select a prepared source directory. Pioneer still validates and copies it; it never points the actor directly at the original.

## Network modes

| Mode | Proxy destinations | Default |
| --- | --- | --- |
| `full` | Public destinations and other LAN hosts | Reviews |
| `public` | Public destinations and explicit host grants | Evals |
| `provider-only` | Selected model provider and explicit host grants | Opt-in |

The authenticated HTTP(S) proxy blocks loopback, host interface addresses, and metadata endpoints in all three modes. Repeat `--allow-host` and `--block-host` for names, wildcard subdomains, IPs, or CIDRs. Blocks take precedence. The proxy checks hostname rules before DNS and connects to a validated address. Check the `[PIONEER_NETWORK]` line for the effective policy.

On Linux, a private Unix socket connects the actor's namespace proxy to the controller. On macOS, Seatbelt allows the per-run proxy endpoint. To reach a local service directly from an eval, pass `--allow-loopback 127.0.0.1:PORT` for each exact port. Each granted service receives requests from the untrusted actor.

Pioneer's offline Pi startup flags skip optional startup checks. A review still needs egress to its configured provider, so `--network none` is rejected before launch.

## Controller-only provider authentication

On macOS and Linux, pass `--controller-provider-auth` to `review` or before the command separator in `eval run`. Select an exact `--model PROVIDER/MODEL`. The source Pi home's `models.json` must declare the provider and model with a public HTTPS `baseUrl` and a supported API. Configure an API key in the Pi home as a literal or through Pi's environment interpolation. Compatible OpenAI-style APIs also accept a current standard bearer OAuth credential. Renew expired OAuth in Pi.

Pi receives a run-scoped placeholder. Only the controller's private inference gateway sends the original credential to the configured upstream. This mode disables user extensions and review resumption. Use the official Pi actor for evals and omit explicit extensions, `--api-key`, and eval `--env`. Omit Pi-home includes for reviews. [Supported APIs and options](../docs/CLI-REFERENCE.md#controller-only-provider-authentication)

## Platform enforcement

### macOS

Pioneer generates a deny-by-default Seatbelt profile and launches the actor through `/usr/bin/sandbox-exec`. Apple offers no public replacement with comparable dynamic sandboxing for arbitrary command-line children. Release validation includes live boundary tests.

### Linux

Pioneer creates a minimal Bubblewrap mount and namespace environment, drops capabilities, and gives the actor private `/proc` and `/dev` views. Bubblewrap normally works without administrator privileges. On Ubuntu configurations that restrict unprivileged user namespaces, use the narrow AppArmor setup described in [Getting started](getting-started.md#3-linux-sandbox-dependency).

### Windows

Windows reviews rely on review instructions and model compliance for source immutability, and use the host's network policy. The plugin must explain these limits and obtain approval before passing `--allow-unsandboxed-windows`. Provider-only networking, host filters, and controller-only provider authentication require native enforcement on macOS or Linux.

Strict eval actors are unsupported on Windows and fail closed. The technical record for the experimental AppContainer path is in [Windows sandbox prototype](../docs/WINDOWS-SANDBOX-PROTOTYPE.md).

## Verify the boundary

From the source checkout, run:

```bash
npm run sandbox:smoke
```

The tests check editor-directory reads, denied source writes, and allowed scratch writes. They also check denied outside content and metadata access, allowed public proxy traffic, and denied direct loopback access. Run them on each supported operating system before a release.
