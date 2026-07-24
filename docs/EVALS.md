# Isolated skill evals

Pioneer prepares separate baseline and with-skill actor directories and runs each actor behind a native operating-system sandbox. It has no dependency on Anthropic Sandbox Runtime.

## Platform status

Verified on 2026-07-23:

| Platform | Status | Evidence |
| --- | --- | --- |
| macOS 26 arm64 | Pass | Mandatory eval probes passed. `npm run sandbox:smoke` read `.idea` and `.vscode`, denied a source write plus outside content and leaf-metadata reads, wrote scratch, fetched `https://example.com` through the authenticated proxy, and denied a raw loopback bypass. A live `xai/grok-4.3` Pi review completed without changing the source digest. |
| Linux, WSL2 kernel 6.6.87.2, Node 22.22.1, Bubblewrap 0.11.1 | Pass | Full `npm run check` and the same filesystem/network smoke battery passed. Source writes failed `EROFS`; outside paths were absent from the mount namespace. |
| Ubuntu 26.04 Hyper-V VM, kernel 7.0.0-1007-azure, Node 22.22.1, Bubblewrap 0.11.1 | Pass | Connected as `seb` using the Windows host's SSH key. A clean install, all 79 tests, the packed-install/CLI smoke, release metadata verification, and the complete filesystem/network smoke battery passed. The smoke used the production-resolved narrow AppArmor-enabled Bubblewrap copy. |
| Windows 11, Node 24.16.0, npm 12.0.1 | Eval runs fail closed | All 76 applicable tests passed, with three Unix-only tests skipped. The packed-install/CLI smoke, Windows fail-closed contract smoke, and .NET 8 AppContainer prototype build passed. No stable AppContainer launcher is available; Windows review mode remains explicitly unsandboxed and opt-in. |

Run the repeatable native battery with:

```bash
npm run sandbox:smoke
```

The smoke test uses harmless disposable files. It checks ordinary read-only access to `.idea` and `.vscode`, source immutability, outside content and leaf-metadata denial, scratch writes, mediated public egress, and direct-loopback denial. Pioneer has no special filename or editor-directory deny list.

## Native implementation

macOS invokes `/usr/bin/sandbox-exec` directly with a generated Seatbelt profile. The profile starts at `deny default`, permits only the caller's canonical read/write grants and required runtime paths, and permits outbound TCP only to the per-run authenticated proxy port.

Linux invokes Bubblewrap directly. It starts with an empty tmpfs root, bind-mounts runtime/source/reference paths read-only, bind-mounts scratch and explicit write grants read-write, creates fresh user/PID/network/IPC/UTS namespaces, drops all capabilities, and mounts private `/proc` and `/dev` views.

For Linux egress, the host proxy is exposed as one mode-0600 Unix socket. A small Pioneer Node supervisor inside the network namespace listens on loopback port 3128 and relays only to that socket. The reviewed/evaluated process receives the authenticated proxy URL. Raw host/LAN/loopback networking remains impossible because it has no host network interface. The parent proxy performs destination policy and pins the selected DNS result before connecting.

No launcher interpolates actor-controlled values into a shell command. Commands and arguments remain discrete argv entries. The Linux network supervisor spawns the actor with `shell: false`.

## Threat model and mandatory probes

The eval actor is untrusted. It must not read source skills, eval definitions, answer keys, sibling arms, user files, real credential stores, or host-only environment values. Persistent writes are confined to the actor's run directory.

Every eval run first proves that the sandboxed process:

- cannot read a controller-created sentinel outside the run directory;
- cannot modify that sentinel;
- does not inherit a host-only secret;
- cannot connect directly to a listening loopback service; and
- can execute with the requested runtime grants.

The actor does not start if a dependency, canonicalization step, model preflight, or mandatory probe fails. There is no unconfined eval fallback.

## Network policy

Eval actors may use the public internet but not loopback, link-local, private, carrier-grade NAT, documentation, multicast, reserved, or other non-global IPv4/IPv6 ranges.

The authenticated parent proxy:

- rejects local host suffixes;
- resolves names before connecting;
- requires every returned address to be globally routable; and
- connects to the selected validated address, preventing a DNS-rebinding race.

Review `full` mode uses the same mediation but permits public, LAN, and loopback destinations. Review `public` uses eval-style public-only resolution. `none` provides no proxy.

## Prepare and run a battery

```bash
npm run eval -- prepare \
  --skill /path/to/skill \
  --evals /path/to/skill/evals/evals.json \
  --output /path/to/new-eval-battery

npm run eval -- run \
  --run-dir /path/to/battery/actor-runs/eval-1/with-skill \
  --runtime-read /absolute/path/to/a/required/tool-runtime \
  --deny-read-probe /path/to/controller/answer-key \
  -- pi --mode rpc
```

The prepared output must not already exist and must be outside the source skill. Symlinks in the source skill are rejected. Each eval gets independent baseline and with-skill directories; only the latter receives a sanitized skill copy. Expectations and answer keys never enter actor-visible storage.

`--runtime-read` accepts narrowly scoped, read-only tool runtimes. Filesystem roots, home roots, `/tmp`, `/var`, and other broad grants are rejected.

The runner snapshots `PI_CODING_AGENT_DIR` (or `~/.pi/agent`) into the writable eval run. Sessions, logs, caches, root temporary trees, and configured skills are excluded. Pi package content required by configured extensions is retained. `--pi-home DIR` selects another snapshot source; the source is validated and copied, never used in place.

When the actor command is Pi, the runner adds `--offline`, `--no-session`, `--no-approve`, `--no-prompt-templates`, `--no-themes`, and `--no-skills`, plus `PI_OFFLINE=1` and `PI_TELEMETRY=0`.

Pi/model readiness is checked before actor artifacts are created. Qualified `provider/model` names must match exactly; an unqualified ID must be unique. Missing or ambiguous requests fail with the configured qualified model list. Thinking levels include `xhigh` and `max`.

## Setup

On macOS, no privileged setup is required:

```bash
npm run eval -- doctor
npm run sandbox:smoke
```

On Linux, install Bubblewrap. Node is already a project requirement:

```bash
sudo apt-get install bubblewrap
npm run eval -- doctor
npm run sandbox:smoke
```

Bubblewrap normally runs without administrator privileges. Ubuntu 24.04 and newer may restrict unprivileged user namespaces through AppArmor. Do not disable that restriction globally. Install the narrow project profile instead:

```bash
npm run build
sudo node dist/eval-run-cli.js install-linux
npm run eval -- doctor
```

The installer copies only `/usr/bin/bwrap` to `/usr/local/libexec/pioneer/bwrap`, makes it root-owned mode 0755, and loads an AppArmor profile granting `userns` only to that fixed executable. There is no seccomp helper, global sysctl change, or package-owned compatibility directory.

## Windows limitation

Eval `doctor` reports unsupported and `run` stops before actor launch or ACL mutation. The native AppContainer experiment is documented in [WINDOWS-SANDBOX-PROTOTYPE.md](WINDOWS-SANDBOX-PROTOTYPE.md). It remains feature-gated by the tested Windows build.

## Remaining limitations

- macOS uses the legacy `sandbox-exec` interface, for which Apple provides no public drop-in replacement for dynamically sandboxing arbitrary CLI processes. Its behavior is therefore covered by mandatory release smoke tests.
- Provider-aware tools must honor standard HTTP(S) proxy variables to use mediated egress. Raw TCP is intentionally unavailable inside Linux's isolated network namespace.
- The harness prepares and isolates eval arms; complete grading/orchestration remains separate work.
