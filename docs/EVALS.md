# Isolated skill evals

Pioneer prepares separate baseline and with-skill directories. Each actor runs in a native operating-system sandbox. Pioneer does not depend on Anthropic Sandbox Runtime.

## Platform status

Verified on 2026-07-23 unless the row states otherwise:

| Platform | Status | Evidence |
| --- | --- | --- |
| macOS 26 arm64 | Pass | Mandatory eval probes passed. `npm run sandbox:smoke` read `.idea` and `.vscode`, denied a source write plus outside content and leaf-metadata reads, wrote scratch, fetched `https://example.com` through the authenticated proxy, and denied a raw loopback bypass. A live `xai/grok-4.3` Pi review completed without changing the source digest. |
| Linux, WSL2 kernel 6.6.87.2, Node 22.22.1, Bubblewrap 0.11.1 | Pass | Full `npm run check` and the same filesystem/network smoke battery passed. Source writes failed `EROFS`; outside paths were absent from the mount namespace. |
| Ubuntu 26.04 Hyper-V VM, kernel 7.0.0-1007-azure, Node 22.22.1, Bubblewrap 0.11.1 | Pass | Connected as `seb` using the Windows host's SSH key. A clean install, all 79 tests, the packed-install/CLI smoke, release metadata verification, and the complete filesystem/network smoke battery passed. The smoke used the production-resolved narrow AppArmor-enabled Bubblewrap copy. |
| Ubuntu 26.04 LTS, kernel 7.0.0-29-generic x86_64, Node 22.23.2, Bubblewrap 0.11.1 | Pass | Verified 2026-08-19 on bare metal with `apparmor_restrict_unprivileged_userns=1`, using the supported `eval install-linux` AppArmor profile. `npm run check` and the full filesystem/network smoke battery passed. Source writes failed `EROFS`; outside paths were absent from the mount namespace. A leaked descendant holding inherited pipes was destroyed with the PID namespace. |
| Windows 11, Node 24.16.0, npm 12.0.1 | Eval runs fail closed | All 76 applicable tests passed, with three Unix-only tests skipped. The packed-install/CLI smoke and Windows fail-closed contract smoke passed. No stable AppContainer launcher is available; Windows review mode remains explicitly unsandboxed and opt-in. |

Run the repeatable native battery with:

```bash
npm run sandbox:smoke
```

The smoke test uses harmless disposable files. It checks read-only access to `.idea` and `.vscode`, source immutability, outside content and leaf-metadata denial, scratch writes, mediated public egress, and direct-loopback denial. Pioneer does not deny specific filenames or editor directories.

Issue #17's live macOS acceptance test ran on 2026-08-14 with Pi 0.84.1 and `openai-codex/gpt-5.6-luna`. It exited 0 in 9.65 seconds against a 90-second timeout. Stdout contained exactly `OK` and one newline, with no eval diagnostic. The disposable run directory was removed after capture.

The native timeout test returned `[EVAL_TIMEOUT]` and both pre-timeout markers in 1.167 seconds. The retained-pipe test returned `[EVAL_PROCESS_CONTAINMENT_FAILED]` and its marker in 1.012 seconds. Both exited nonzero and left no disposable actor running.

## Native implementation

On macOS, Pioneer invokes `/usr/bin/sandbox-exec` directly with a generated Seatbelt profile. Starting from `deny default`, it allows canonical read/write grants and required runtimes. Outbound TCP reaches only the per-run authenticated proxy port and explicit `--allow-loopback` ports.

The profile permits reads and writes to `/dev/null`. Libuv's `posix_spawn` opens it for ignored stdio slots used by Pi's `bash` tool. Git also opens it at startup. An ioctl-only grant caused both to fail with `EPERM`.

Eval runs grant read-only access to `/private/var/select`, where `/bin/sh` reads its shell choice. They also grant the toolchain selected by `developer_dir`:

- `/Library/Developer/CommandLineTools`; or
- the whole Xcode bundle for an `/Applications/*.app/Contents/Developer` selection. Xcode tools need the bundle's `Info.plist` and `SharedFrameworks`.

Other `developer_dir` targets receive no grant. Evals also grant `/Library/Preferences/com.apple.dt.Xcode.plist`, where xcrun checks license acceptance. These grants let the `/usr/bin/git` shim work. Xcrun can still warn that it cannot write its cache in the ungranted shared per-user temporary directory.

Tools such as `xcode-select` use `/var/select/developer_dir`, while canonical grants use `/private/...`. The profile therefore permits reading the root `/etc`, `/tmp`, or `/var` alias symlink when a grant lies below its `/private` target.

On Linux, Pioneer invokes Bubblewrap directly. It starts with an empty tmpfs root and mounts runtimes, source, and references read-only. Scratch and explicit write grants are read-write. It creates fresh user/PID/network/IPC/UTS namespaces, drops all capabilities, and mounts private `/proc` and `/dev` views.

On usrmerged distributions, `/bin` canonicalizes to `/usr/bin`. Pioneer adds a `/bin -> usr/bin` alias so `/bin/sh` resolves, as with the existing `/lib` and `/lib64` aliases.

All required Bubblewrap options exist in 0.2.0 (2017). The newest is `--cap-drop ALL`. `--die-with-parent` arrived in 0.1.8. The tmpfs root, `--dir` ancestors, `--symlink` runtime-linker aliases, `--unshare-*` namespaces, and `--unshare-cgroup-try` predate 0.2.0.

Pioneer does not probe the Bubblewrap version. Distribution `bwrap` packages provide the required options. The platform table records tested versions without setting a minimum.

`npm run sandbox:smoke` checks process containment separately on each platform.

On Linux, Bubblewrap runs as PID 1 in a `--unshare-pid` namespace. After the actor exits, the kernel destroys all remaining namespace processes and closes inherited pipes. A leaked descendant therefore produces a clean exit without a containment diagnostic.

Seatbelt has no PID namespace on macOS. A descendant can survive with inherited pipes open. When the pipe-close grace expires, Pioneer fails with `[EVAL_PROCESS_CONTAINMENT_FAILED]`.

Linux exposes the host proxy through one mode-0600 Unix socket. A Pioneer Node supervisor listens on namespace loopback port 3128 and relays only to that socket. The review/eval process gets the authenticated proxy URL. It has no host network interface, so raw host/LAN/loopback connections remain unavailable. The parent proxy checks destinations and pins the selected DNS result before connecting.

Each `--allow-loopback` port gets a separate mode-0600 Unix socket. The controller relays it only to that host loopback port. Before actor launch, the supervisor listens on `127.0.0.1:PORT` inside the namespace.

Launchers pass commands and arguments as separate argv entries. They never insert actor-controlled values into shell commands. The Linux supervisor spawns actors with `shell: false`.

## Threat model and mandatory probes

Eval actors are untrusted. They must not read source skills, eval definitions, answer keys, sibling arms, user files, real credential stores, or host-only environment values. Persistent writes stay inside the actor run directory.

Every eval run first proves that the sandboxed process:

- cannot read a controller-created sentinel outside the run directory;
- cannot modify that sentinel;
- does not inherit a host-only secret;
- cannot connect directly to a listening loopback service; and
- can execute with the requested runtime grants.

A failed dependency, canonicalization step, model preflight, or mandatory probe stops actor launch. Evals never fall back to unconfined execution. Pioneer handles SIGINT/SIGTERM from the first async setup step through cleanup. It returns `[EVAL_INTERRUPTED]` only after removing temporary controller and credential material.

Pioneer resolves the executable before writing launch artifacts to the run directory. Bare names use the sanitized controller `PATH`. Relative paths use the validated actor run directory. Absolute paths receive direct validation. Symlink launchers get read-only grants for only their exact lexical path and canonical target.

A Pi package root must not overlap the writable run tree in either direction. `/usr/bin/env` shebang inspection reads a bounded prefix and rejects cyclic or excessively deep chains. Missing, non-executable, directory, broken-link, NUL-containing, and escaping relative paths fail closed.

Pioneer preserves partial output up to 4 MiB stdout and 64 KiB stderr. Exceeding either limit returns nonzero with `[EVAL_OUTPUT_LIMIT]` and the stream name. For larger output, such as `pi --mode json` with images, use `--stdout-file` or `--stderr-file`. Each streams its output to a new controller-owned file with a 1 GiB bound.

Other failures use these diagnostics:

- `[EVAL_TIMEOUT]` for timeout;
- `[EVAL_INTERRUPTED]` for interruption;
- `[EVAL_SPAWN_FAILED]` for launch failure;
- `[EVAL_SHEBANG_RESOLUTION_FAILED]` for cyclic, excessively deep, or unterminated-overlong `/usr/bin/env` chains;
- `[EVAL_PROCESS_CONTAINMENT_FAILED]` for retained inherited pipes where descendants can outlive the actor. Linux's PID namespace destroys those descendants, so this diagnostic is unreachable there.

Diagnostics exclude the full environment, Pi configuration, and authenticated proxy URL.

## Network policy

Eval actors can use the public internet. They cannot reach loopback, link-local, private, carrier-grade NAT, documentation, multicast, reserved, or other non-global IPv4/IPv6 ranges by default.

`eval run --allow-loopback 127.0.0.1:PORT` opens only that exact host loopback port. Pioneer sets `NO_PROXY=127.0.0.1,localhost` for direct connections from proxy-aware clients. The proxy still refuses loopback. Other loopback ports stay closed. The mandatory probe uses a listener outside the allow list.

The authenticated parent proxy:

- rejects local host suffixes;
- resolves names before connecting;
- requires every returned address to be globally routable; and
- connects to the selected validated address, preventing a DNS-rebinding race.

Review `full` uses the same proxy mediation and allows public, LAN, and loopback destinations. Review `public` uses eval-style public-only resolution. Pioneer rejects review `none` before launch because the model provider needs proxy-mediated egress.

## Prepare and run a battery

```bash
npm run pioneer -- eval prepare \
  --skill /path/to/skill \
  --evals /path/to/skill/evals/evals.json \
  --output /path/to/new-eval-battery

npm run pioneer -- eval run \
  --run-dir /path/to/battery/actor-runs/eval-1/with-skill \
  --runtime-read /absolute/path/to/a/required/tool-runtime \
  --deny-read-probe /path/to/controller/answer-key \
  -- pi --mode rpc
```

Prepare stages fixtures under `fixtures/`, one level below each actor working directory. It rewrites prompt paths to resolve from that working directory and keeps the original in `case.json`'s `source_prompt`. It reports `actorContract` on stdout and `[PIONEER_EVAL_ACTOR_CONTRACT]` on stderr.

`eval run` repeats the contract line and lists staged files in bounded `[PIONEER_EVAL_FIXTURES]` lines. Actors can list the run directory and `fixtures/` without guessing paths or launching a `find` search that the sandbox could deny.

The output must not exist. Its canonical parent must place it outside the source skill. Pioneer rechecks the created destination before adding descendants. `skill_name` must be one portable component within the 255-byte filename limit. Before creating output, Pioneer rejects absolute, empty, dot, separator-containing, Windows-reserved, invalid-character, and trailing-dot/space values. It also rejects source-skill symlinks.

Paths or content that reveal expected findings fail before output creation with `[EVAL_FIXTURE_LEAK]`. `--allow-fixture-name GLOB` waives only filename collisions. Every `files[]` entry must be a regular file no larger than 64 MiB. Directories, special files, and larger files fail before output creation. See [Fixture checks](#fixture-checks).

Each eval has independent baseline and with-skill directories. Only with-skill receives a sanitized skill copy. Actor-visible storage never contains expectations or answer keys. Actors can see every staged filename.

Writable `--run-dir` and caller-supplied read-only `--runtime-read` grants must be narrow and non-overlapping. The real Pi home must stay outside every actor grant. Pioneer omits controller-derived executable grants already covered by the run directory.

Pioneer rejects writable protected-system roots and descendants. It also rejects broad filesystem, sensitive-configuration, home, temporary, and variable-data roots and canonical platform aliases. Narrow read-only system runtimes and disposable temporary descendants remain supported.

The runner snapshots `PI_CODING_AGENT_DIR` or `~/.pi/agent` into a canonical private temporary tree outside the persistent eval run. The root allowlist is `auth.json`, `models.json`, `models-store.json`, `settings.json`, and `AGENTS.md`. The actor gets a writable isolated `agentDir`, allowing Pi 0.84.x to create `auth.json.lock` and `settings.json.lock`. Home/tmp scratch is separate, writable, and temporary.

Pioneer never mounts the source Pi home or puts controller launch/probe files in the actor run. It removes the whole temporary tree on every exit. The snapshot excludes configured skills and default-skipped package/runtime trees. Hard exclusions cover sessions, logs, `.npm`, `.cache`, transient directories, and log files, case-insensitively on macOS and Windows. Evals have no include flag.

Pioneer stages trusted official Pi user extensions read-only beside the snapshot and passes them explicitly. Ambient discovery stays disabled. `--pi-home DIR` selects a different source to validate and copy, never to use in place. The selected snapshot alone has 500,000-entry and 1 GiB limits.

After native-sandbox and default Pi-home readiness pass, `eval run` writes a controller-owned JSONL work log. `--work-log FILE` selects a create-only absolute path outside actor visibility. Otherwise Pioneer creates a unique `eval-*.jsonl` file in:

- macOS: `~/Library/Logs/Pioneer/evals/`;
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pioneer/logs/evals/`;
- Windows: `%LOCALAPPDATA%\Pioneer\Logs\evals\`.

Pioneer prints `[PIONEER_EVAL_WORK_LOG] ABSOLUTE_PATH` to stderr immediately after opening the log. Records include timestamps, elapsed time, bounded exit metadata, and stages: `sandbox_readiness`, `pi_readiness`, `pi_home_snapshot`, `network_proxy`, `isolation_probe`, `actor`, and `cleanup`.

The `network_proxy` completion lists `allowedLoopback` targets. Actor start lists `actorEnvironmentNames` from `--env` and `toolExtensionCount`. Logs exclude prompts, credentials, environment values, and proxy URLs. `[EVAL_WORK_LOG_CREATE_FAILED]` and `[EVAL_WORK_LOG_WRITE_FAILED]` stop the run.

For Pi or the trusted official package's declared `pi` entry point, the runner adds `--offline`, `--no-session`, `--no-approve`, `--no-extensions`, `--no-prompt-templates`, `--no-themes`, and `--no-skills`. It also sets `PI_OFFLINE=1` and `PI_TELEMETRY=0`.

Pi 1.0.4+ also gets `--no-mcp`, because `--tools` keeps MCP tools unless an entry starts with `mcp__`. Pioneer adds it after readiness, including deferred extension readiness and `--pi-home` probes, and after extension staging rebuilds the command. Launcher wrapping preserves actor identity. Custom non-Pi actors remain unchanged, including arguments such as `--tools` or `--no-extensions`. Tool-restricted Pi actors with no known launch version fail with `[PI_NO_MCP_VERSION_UNKNOWN]`.

For the official package, Pioneer adds one `--extension` per staged enabled user extension and uses the tool-stripping adapter. Passing `--no-extensions` or `-ne` on the Pi command skips user-extension staging and keeps only built-in providers. If the snapshot contains OAuth credentials and the package supports the auth adapter, that opt-out still starts the provider-scoped broker and auth adapter.

Explicit `--extension` or `-e` paths must name regular files in dedicated directories. Pioneer rejects files directly in shared temp, home, filesystem roots, or broad system directories such as `/opt`, `/srv`, `/usr`, `/mnt`, and `/media`. It also rejects Pi private session/log storage, directories containing the Pi agent directory, credential directories such as `.ssh` and `.aws`, and files directly in `.config`.

Pioneer stages the file's directory so sibling imports resolve. Readiness and OAuth refresh both load the staged entry. A trusted package without adapter support fails closed unless the command uses `--no-extensions` or `-ne`. It always rejects explicit extensions without adapter support.

To keep a Pi extension's tools, use `eval run --pi-extension PATH`, for example for an MCP adapter. PATH can be a file or package directory. Package entries resolve from `package.json` `pi.extensions` or `index.ts`/`index.js` and must stay inside the package. Pioneer stages the source read-only under the same location policy and passes `--extension`. The adapter trusts only that copy to retain tools.

This option requires the trusted official Pi package. If the extension is also enabled in Pi or passed with `-e`, the run fails with `[PI_EXTENSION_TOOL_SOURCE_INVALID]`. Only the actor initializes it; discovery and the OAuth worker do not. It can therefore depend on actor `--env` values, run-directory files, Pi arguments, and `--allow-loopback` ports at startup. Failed actor initialization exits nonzero with `[PI_EXTENSION_LOAD_FAILED]`.

`eval run --env NAME=VALUE` passes operator variables, such as an adapter configuration path. Pioneer-controlled values take precedence, and reserved names fail validation.

Pioneer checks Pi/model readiness before creating actor artifacts. Qualified `provider/model` names must match exactly; unqualified IDs must be unique. Missing or ambiguous requests fail with the configured qualified model list. Thinking levels include `xhigh` and `max`.

## Fixture checks

`eval prepare` checks every `files[]` entry before it creates the output directory. A failed check stops prepare with a stable diagnostic.

### Paths must not reveal expected findings

Pioneer splits path components on `-`, `_`, `.`, and camelCase/PascalCase word boundaries. A resulting word of `stale`, `bug`, `defect`, `bad`, `good`, `broken`, `wrong`, `negative`, `positive`, `rough`, `showcase`, `expected`, `fixture`, or `case` fails with `[EVAL_FIXTURE_LEAK]`.

`case` and `fixture` can appear in real class names. Pioneer allows them when joined to another camelCase/PascalCase word, as in `BadgeCase.kt` and `TestFixture.kt`. Whole names and delimited tokens such as `Fixture.kt`, `test-fixture.kt`, and `case/` still fail.

Pioneer checks both `files[]` source paths and actor-visible staged paths below `fixtures/`. Sources outside `evals/files/` use their basename when staged. The source check therefore rejects `samples/fixture/parser.ts` even though the actor sees only `fixtures/parser.ts`.

Repeat `--allow-fixture-name GLOB` to waive paths matching a source path, staged path, or basename. This never waives content markers.

### Content markers fail the check

Pioneer rejects `BUG:`, `TODO:`, and `FIXME` in any letter case, and bare uppercase `TODO` or `XXX`. Bare lowercase `todo` and `xxx` pass, including fixtures for todo-list apps. Markers match whole tokens: `DEBUG:` does not match `BUG:`, `todos` does not match `TODO`, and `fixmeLater` does not match `FIXME`.

`todo` is not a path term, so `TODO-list.md` passes. That common filename does not identify a defect. A `TODO` content marker can point the actor to an expected finding and therefore fails.

### Staging checks file identity and bytes

Each fixture must be a regular file no larger than 64 MiB. Pioneer opens it without following a final symbolic link or blocking on a FIFO. It checks type and size with `fstat` on that descriptor. Directories and special files fail. Oversized files fail with `[EVAL_FIXTURE_TOO_LARGE]`.

The content scan streams from the same descriptor with bounded memory. Overlapping chunks detect markers across chunk boundaries. Pioneer then closes the file and records device, inode, size, modification/change times, and permission bits. Large batteries therefore do not hold many descriptors open.

Each staged copy reopens the file and checks identity before and during copying. Changes fail with `[EVAL_FIXTURE_CHANGED]`. Pioneer empties partial copies through their own descriptors rather than deleting by path. It rescans content while writing and rechecks size while reading. Only checked bytes reach `fixtures/`, even if a source path changes during prepare.

If a staged copy fails the second scan, Pioneer removes it and stops. The partial output directory remains and must not be used.

## Setup

macOS needs no privileged setup:

```bash
npm run pioneer -- doctor
npm run sandbox:smoke
```

On Linux, install Bubblewrap. All releases from 0.2.0 provide the required options. The project already requires Node:

```bash
sudo apt-get install bubblewrap
npm run pioneer -- doctor
npm run sandbox:smoke
```

Bubblewrap normally needs no administrator privileges. Ubuntu 24.04+ can restrict unprivileged user namespaces through AppArmor. Keep that global restriction. Install the narrow project profile:

```bash
npm run build
sudo node dist/review-cli.js eval install-linux
npm run pioneer -- doctor
```

The installer copies only `/usr/bin/bwrap` to `/usr/local/libexec/pioneer/bwrap` and sets root ownership and mode 0755. It loads an AppArmor profile granting `userns` only to that executable. It adds no seccomp helper or package-owned compatibility directory and changes no global sysctl.

## Windows limitation

Eval `doctor` reports unsupported. `run` stops before launching an actor or changing ACLs. The [native AppContainer experiment](WINDOWS-SANDBOX-PROTOTYPE.md) remains feature-gated by the tested Windows build.

## Remaining limitations

- macOS uses legacy `sandbox-exec`. Apple offers no public drop-in replacement for dynamically sandboxing arbitrary CLI processes. Mandatory release smoke tests check its behavior.
- Provider-aware tools must honor standard HTTP(S) proxy variables. Linux's isolated network namespace provides no raw TCP egress.
- Pioneer prepares and isolates eval arms. Complete grading and orchestration remain separate work.

The native smoke runs a provider-free disposable actor through `runEvalCommand`. It covers bare executable resolution, the production path, native policy, isolated Pi credential-lock creation, and output propagation. Live provider acceptance is a separate operator-controlled check.

`npm run test:e2e` drives the built CLI against a scripted Pi installation without credentials. It covers fixture staging, actor listing, credential locks, work-log stages, startup flags, process-tree timeout, fail-closed Pi/model preflight, and controller-material denial.
