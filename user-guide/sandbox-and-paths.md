# Sandbox and path grants

Pioneer treats the review actor as untrusted. On macOS and Linux, it starts from explicit capabilities instead of giving Pi the caller's normal filesystem and network access.

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

Pioneer canonicalizes grants before launch. It rejects a source grant that is a symbolic link, grants that overlap with conflicting access, and unsafe broad eval runtime grants. An explicit writable path is a real host capability, so grant the narrowest directory that meets the request.

Eval actor commands are validated before launch artifacts are created. Bare executable names are found only through Pioneer's sanitized `PATH`; relative paths are resolved below the actor run directory; absolute symlink launchers retain only exact lexical and canonical read grants. Missing or non-executable targets fail closed, and Pioneer's timeout/containment handling terminates the native process group rather than waiting on inherited output pipes.

The private scratch and copied Pi home are deleted when the review finishes. Use `--report /absolute/path/report.md` when you need Pioneer to preserve the final Markdown report; that does not require giving Pi another writable path.

## Isolated Pi home

By default, Pioneer selectively copies `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when the variable is unset, into the private run area. The root allowlist is `auth.json`, `models.json`, `models-store.json`, `settings.json`, and `AGENTS.md`; review snapshots also include a sanitized `skills/` tree, while eval snapshots do not. Dependency/runtime fluff such as `node_modules/` and `.git/` is skipped inside that traversed skills tree; root-level `npm/`, `git/`, and unknown paths are not in the allowlist, while valid skill directories named `git` or `npm` remain available.

For reviews, repeat `--pi-home-include RELATIVE_PATH` to select one exact existing file or directory relative to the selected Pi home. Use the attached form `--pi-home-include=--NAME` when the exact path begins with `--`. This can opt into normally skipped package content, but not hard exclusions: `sessions/`, `logs/`, `.npm/`, `.cache/`, `tmp/`, `.tmp/`, `temp/`, and `*.log` paths. These names are matched case-insensitively on macOS and Windows. Includes do not accept globs, negation, or configuration files. Internal symlinks are copied only when their targets are selected; broken, escaping, special-file, unselected-target, and ambiguous-collision cases fail closed. Evals have no include opt-in.

Both modes cap selected content at 500,000 entries and 1 GiB; skipped content does not consume those budgets. Opting into large or machine-specific directories increases storage, runtime, and portability risk. Optional extension discovery remains disabled for both review and eval actors. Eval snapshots use an external private temporary tree: the isolated `agentDir` is writable so Pi can create credential lock directories, writable home/tmp scratch is separate, the source Pi home is never mounted, and everything is removed when the run ends.

Use `--pi-home /absolute/path` to select a prepared source directory. Pioneer still validates and copies it; it never points the actor directly at the original.

## Network modes

| Mode | Public internet | LAN | Loopback | Intended use |
| --- | --- | --- | --- | --- |
| `full` | Yes | Yes | Yes | Default reviews; local deployments may be probed |
| `public` | Yes | No | No | Reviews that only need providers or public references |
| `none` | No | No | No | Fully offline reviews |

Traffic is mediated by a per-run authenticated HTTP(S) proxy. In `public` mode, the proxy resolves destinations, rejects non-global results, pins the accepted address, and therefore also closes the DNS-rebinding window.

On Linux, the actor has a fresh network namespace and can reach only a loopback proxy bridge connected to the parent proxy through a private Unix socket. Tools that ignore standard proxy variables cannot use the network. On macOS, Seatbelt limits the actor to the per-run proxy endpoint.

`--offline`-style Pi startup flags skip optional startup checks. They do not prevent the selected provider call; use `--network none` when the entire review must be offline.

## Platform enforcement

### macOS

Pioneer generates a deny-by-default Seatbelt profile and launches the actor through the system-provided `/usr/bin/sandbox-exec` interface. Apple offers no public drop-in replacement for dynamically applying a comparable sandbox to arbitrary command-line children, so release validation includes live boundary tests.

### Linux

Pioneer creates a minimal Bubblewrap mount and namespace environment, drops capabilities, and gives the actor private `/proc` and `/dev` views. Bubblewrap normally works without administrator privileges. On Ubuntu configurations that restrict unprivileged user namespaces, use the narrow AppArmor setup described in [Getting started](getting-started.md#3-linux-sandbox-dependency).

### Windows

Windows reviews are not enforceably sandboxed. Pioneer stops unless the caller explicitly passes `--allow-unsandboxed-windows`; the plugin must explain the limitation and obtain approval before doing so. Source immutability then relies on review instructions and model compliance only.

Strict eval actors are unsupported on Windows and fail closed. The technical record for the experimental AppContainer path is in [Windows sandbox prototype](../docs/WINDOWS-SANDBOX-PROTOTYPE.md).

## Verify the boundary

From the source checkout, run:

```bash
npm run sandbox:smoke
```

The battery proves that normal editor directories remain readable, source writes fail, scratch writes succeed, outside content and file metadata are hidden, mediated public egress succeeds, and a direct loopback bypass fails. Run it on each supported operating system before a release.
