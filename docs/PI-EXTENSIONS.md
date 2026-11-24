# Pi extensions in reviews

Reviews, deep reviews, `models`, `doctor`, and strict evals load the operator's enabled user extensions by default. Pioneer allows provider registration and authentication hooks without a provider allowlist. It disables ambient discovery by passing `--no-extensions`, then adds staged paths with `--extension`. It removes extension tools.

To use only built-in providers, pass `--no-extensions` to `review`, `models`, or `doctor`, or `extensions: false` to the review API. Evals use only built-in providers when the Pi command includes `--no-extensions` or `-ne`, or the actor is not the trusted official Pi package. An explicit `--extension` or `-e` still loads through the tool-stripping adapter alongside that opt-out. A trusted package that cannot host the adapter rejects the explicit extension.

Evals use the review's read-only extension snapshot and tool-stripping adapter. Their Pi-home snapshot uses the eval allowlist, excludes `skills/`, and has no `--pi-home-include` option.

OAuth refresh uses the review broker and the eval public network policy when the trusted package can host the auth adapter. This includes built-in-only commands with `--no-extensions`. The broker writes rotated tokens to the source credential file under Pi's lock. It does not copy the write to the actor. If the snapshot contains OAuth credentials but the package cannot host the adapter, the run fails before launch.

## Resolution and staging

The controller resolves resources through the installed official Pi package's `DefaultPackageManager`. It uses global settings and disables project trust. It does not import extension code. Pi determines which package, local-file, and auto-discovered extensions are enabled, including disabled-resource filters. Offline resolution does not install missing packages. Pioneer excludes reviewed-project settings and extensions, consistent with `--no-approve`.

Pioneer copies enabled entry points, package assets, and dependencies as data into a private directory. Npm layouts retain `node_modules` and hoisted dependencies. Local extensions must have a dedicated directory containing their dependencies and assets. Copies cannot exceed 1 GiB or 500,000 entries. Dependency links must resolve inside selected code directories. Pioneer rejects filesystem/home roots, special files, and cycles, and excludes Git metadata and package caches.

The controller first selects the source roots and identifies private storage without copying any files. The stage then copies the tree, checks source identity, size, modification time, and change time after each file copy, and revalidates the enabled entry points. The stage records source metadata for every observed entry, including skipped Git metadata and credential files. It collects staged metadata after all copies and permission changes are complete. Manifests are controller-only. The digest uses paths relative to the staging directory and hashes source sizes and execute bits with staged file bytes in the original order.

The cache store uses `pioneer/extension-snapshots/v1/` below an absolute `XDG_CACHE_HOME`, `~/Library/Caches` on macOS, or `~/.cache` on Linux. It checks the cache directories and their ancestors before use. A committed generation keeps the staged code and its package scope in `payload/`. Its manifest, digest, and boot marker sit alongside that directory. The store publishes a generation by atomically renaming a complete staging directory. A source change time within two seconds of staging start, or a run-specific filter that omitted a source file, keeps the staged copy private to that run.

After a machine restart, the store hashes the staged bytes again before granting reuse. It uses the original source sizes and execute bits to reproduce the digest that retained reviews use. If the boot ID is unavailable, this check runs on every lookup. `PIONEER_EXTENSION_CACHE=0` selects per-run staging. Windows also uses per-run staging.
Before reusing a cached snapshot, the controller reads source directory membership, including skipped paths, and checks source identities, size, mode, nanosecond modification and change times, link counts, and symbolic link text. It also checks every staged entry's metadata, the generated parent directories, and the exact bytes of the generated package scope. It reruns the current private-storage exclusions, eval and repository filters, symbolic link checks, and bounded session-header scans. Canonical credential policy roots participate in the cache key so changes to XDG locations cannot reuse a snapshot staged under different credential exclusions.

Each controller acquires its own lease before validating or using a committed generation. Concurrent controllers can lease the same generation while one creator stages a replacement. Collection preserves a leased generation until its owners release it or their process identities show that they exited. Unleased superseded and rejected generations, generations unused for more than 14 days, and the least recently used generations beyond the 3 GiB cache budget move to trash. Later runs drain trash and reclaim abandoned staging directories in the background.

Each committed generation carries a sequence assigned under the cache lock. The sequence is published with the payload and its other metadata, so clock changes and coarse filesystem timestamps cannot change which generation is newest. Earlier entries without a sequence remain eligible for validation until a sequenced entry replaces them.

Pioneer excludes Pi's private runtime storage by exact location:

- the agent directory's `sessions/` and `logs/` directories;
- regular `.log` files directly in the agent directory;
- session directories set through `PI_CODING_AGENT_SESSION_DIR` or `sessionDir`. A relative setting fails with `PI_SESSION_DIR_RELATIVE`.

If that storage is a link, Pioneer also excludes its canonical target and skips dependency links into it. Review and deep-review staging can also use the reviewed repository's `.pi/settings.json` to exclude regular `.jsonl` files and links to them from its configured session directory. Pioneer detects session files by content to cover sessions stored elsewhere, including those from another project or a past `--session-dir` override. See [session history outside known locations](SECURITY.md#session-history-outside-known-locations).

Pioneer copies package dependency directories named `sessions` or `logs` in full. It rejects enabled entry points or code roots inside private session or log storage. Adapt installations with unsupported external runtime dependencies; Pioneer does not grant access to the operator's home.

Staged code has a separate read-only sandbox grant. Pi authentication and configuration use a private writable run-local copy. Native reviews, including built-in-only reviews with `--no-extensions`, refresh OAuth through a controller-owned broker and a separate sandboxed authentication worker. The controller saves rotations under Pi's credential lock. It never copies the review actor's modified credentials back.

When a run uses a shared snapshot, discovery, the actor and the OAuth worker can read the leased generation's `payload/` and the run's own adapter directory. Manifests, leases and other generations stay private. On Linux, Bubblewrap mounts the payload read-only inside a private directory tree that allows traversal to the payload and denies directory listings. macOS Seatbelt grants read access to the payload alone.

A review source, explicit read or write grant, eval run directory, runtime path or controller scratch base that includes the extension cache or lies inside it fails with `PI_EXTENSION_CACHE_GRANT_OVERLAP`. Pass a narrower path or move `XDG_CACHE_HOME` outside the grant. An unreadable or broken grant also stops preparation when Pioneer cannot resolve it to verify isolation. This check applies with `PIONEER_EXTENSION_CACHE=0`, because another run can hold a live snapshot there.

On macOS and Linux, Pioneer verifies bounded SHA-256 digests of immutable run-local inputs before and after each native actor, including the Pi-home snapshot, per-run extension files, and eval launch and probe files. For a leased payload, it checks the original staged metadata, generated directories, and package scope before and after discovery, review, deep review, and OAuth execution. A file change between acquisition and launch, or during execution, invalidates the result. Private `auth.json`, `settings.json`, `models-store.json`, and new runtime files in the writable agent root can still change. A failed check produces `[PI_STAGED_INTEGRITY_FAILED]`.

Discovery and execution share the configuration and extension snapshot. Pioneer removes both temporary directories after the run. Retained sessions store a SHA-256 digest of the extension snapshot. Before loading a resumed session, Pioneer re-stages and checks the code, dependency bytes, and entry-point order. Changes fail with `REVIEW_RESUME_EXTENSIONS_CHANGED`. Older archives without a digest keep their original built-in-only policy.

## Execution and capabilities

Staging copies dedicated extension directories and installed `node_modules` trees, including ancestor dependencies that Node uses for resolution. It does not trace individual imports. The read-only snapshot can contain sibling package files, including disabled extension code. Pioneer never passes disabled entry points to Pi. Keep private data outside code and dependency directories: enabled extensions can read their contents. Staging does not grant the operator's original home or configuration directories.

When Pioneer stages a new copy, a fixed pool of 32 workers stages the entries. The workers take entries one at a time from one cursor per open directory, so pending work stays bounded however many entries a directory holds. Each file is copied with a copy-on-write clone where the filesystem supports one (APFS on macOS, Btrfs or XFS on Linux), and with a normal byte copy elsewhere. After the first failure, no new entry starts, and Pioneer waits for the started ones before it reports the error. The snapshot digest still covers the entries in sorted walk order, with each file's staged bytes after its record. Concurrency changes only when the bytes are read, so digests in existing resume archives stay valid. Time grows with the number of files in the selected trees.

Discovery runs extensions in the native sandbox with private HOME/configuration, no reviewed source grant, and authenticated proxy networking. It follows the review's public/full policy. Standalone `models` and `doctor` use the review default of full proxy access.

Discovery uses the same installed Pi CLI and resource loader as execution. An adapter wraps the loader's public `getExtensions` boundary. It rejects load errors and removes user tool registrations before Pi builds its tool registry. It imports the real CLI once, preserving its dispatcher and startup behavior. Each extension initializes once per process. Discovery and review use separate Pi processes.

Ordinary reviews keep the built-in inspection-tool allowlist. Evals can retain tools from a file or package passed with `eval run --pi-extension PATH`. Pioneer stages it read-only like an explicit `--extension` and tells the adapter to trust it. Other extensions lose their tools. The adapter matches trusted files exactly and trusted directories by path containment with a separator. Sibling directories do not match.

`--pi-extension` supplies tools, not models. Only the actor loads it; discovery and the OAuth worker do not. Those processes lack the actor's `--env` values, run-directory grant, Pi arguments, and `--allow-loopback` ports. An adapter that needs those during startup would fail there. Enabled user extensions and explicit `-e` extensions still participate in discovery. If `--pi-extension` initialization fails in the actor, the adapter stops it with `PI_EXTENSION_LOAD_FAILED` and the run exits nonzero.

Extension tools cannot override `read` or add write, shell, or subagent tools outside the policy. Deep review keeps only its controller-selected bundled inspection extension's tools and configured tool-name allowlist. Provider/auth and other lifecycle hooks stay loaded.

OAuth refresh initializes the same enabled extension snapshot in a separate worker. That worker has no model, prompt, session, reviewed source, or review scratch grant. Deep-review capability-profile extensions also participate in discovery and authentication with the actor's validated file grants. Extensions must register provider authentication during initialization, as they do for discovery.

The worker uses the review's network policy and a private Pi configuration copy containing only the requested provider's credential. It discards other configuration changes. See [credential isolation](SECURITY.md#oauth-refresh-in-native-reviews-and-evals).

The OS sandbox enforces the filesystem, process, and network limits. Tool filtering does not isolate JavaScript code. Enabled extensions run in Pi and can read staged credentials, change private scratch, and send allowed network requests. macOS denies subprocess creation; Linux keeps its contained process policy. Extensions that need subprocesses, external files, local daemons, or proxy-unaware networking can fail and need changes.

By default, Node stops after an unhandled promise rejection. `pi-subagents` 0.75 can cause one at session start by spawning a background child without handling failure. On macOS, the controller passes `--pioneer-no-fork-sandbox` to the staged adapter for review, discovery, deep-review, and Pi comment-check actors. The adapter handles only unhandled `EPERM` errors from `spawn`. It prints one `[PI_EXTENSION_SUBPROCESS_DENIED]` stderr line, names the npm package from the stack when safe, and lets Pi continue.

The review controller accepts only that exact line format from untrusted stderr. It keeps the package name only if the controller staged that package; otherwise it says "An extension". It records `pi_actor_warning` and returns at most eight distinct warning lines, even on success. Discovery reports the line as a readiness warning in `models`, `doctor`, and reviews. Deep review adds a `pi-extension-subprocess-denied` warning naming the council member.

Other unhandled rejections still stop Pi unless Pi or an extension installs its own handler. Eval actors, Linux actors, and Windows reviews can create processes. The adapter installs no handler there, so a spawn `EPERM` keeps Node's default behavior. Pioneer stages a fixed list of compiled adapter modules beside the snapshot. A unit test checks that every relative import of a staged module is also staged.

## Diagnostics and compatibility

Each deep-review actor has separate configuration and extension snapshots. Its runtime directories and scratch use the selected controller scratch base. A custom base therefore also controls extension-copy disk usage. Large extension trees increase disk use and startup time for each concurrent council member. A shared immutable snapshot is a possible future change. Actor homes must remain separate and writable.

Extension failures use `PI_EXTENSION_RESOLUTION_FAILED`, `PI_EXTENSION_RUNTIME_UNSUPPORTED`, `PI_EXTENSION_SNAPSHOT_LIMIT`, `PI_EXTENSION_DISCOVERY_FAILED`, or `PI_EXTENSION_LOAD_FAILED`. Raw initialization errors can contain credentials, so Pioneer suppresses them.

`PI_EXTENSION_LOAD_FAILED` names failing extensions by their last two path segments. It names missing modules by their path below the innermost `node_modules` and omits other absolute module paths. A reported name must use plain characters. It must have no opaque run of 24 or more letters and digits, credential label, or known credential format.

`PI_EXTENSION_SNAPSHOT_LIMIT` names the exceeded limit and staged totals. Staging also stops if session-history scans in one call open more than 500,000 files or read more than 1 GiB. That error gives scan totals without mentioning the shared content budget. For `eval run --pi-extension`, totals include user and explicit extensions staged first. The message points to `--no-extensions` if enabled user extensions consumed budget, or to explicit `-e` extensions otherwise. Compare the installation with normal Pi and fix the reported dependency or sandbox requirement. Do not change models or disable the sandbox.

The adapter has been tested with Pi 0.80.6 and 1.6.0. Pi 0.99 added `builtin:mcp`, `builtin:codemode`, `builtin:tool-search`, and the `builtin:llama.cpp` provider. Pioneer passes `--no-extensions` with staged paths, so these built-in extensions do not load in reviews or evals.

On Pi 1.0.4+, `--tools` keeps MCP tools unless an entry starts with `mcp__`. Pioneer also passes `--no-mcp` to review, deep-review, and eval Pi actors. Evals receive it after readiness, including deferred extension readiness and `--pi-home`, and after extension staging rebuilds the command. Pioneer preserves actor identity through launcher wrapping; it does not infer identity from argv. Custom non-Pi actors stay unchanged.

A tool-restricted Pi actor with no known launch version fails with `[PI_NO_MCP_VERSION_UNKNOWN]`. The minimum Pi version remains 0.80.6, so Pioneer does not require `--no-mcp` on every supported version. The adapter requires the official Node package and its resource-loader/package-manager contracts. It accepts a global npm install or Pi's managed installer layout, which [Architecture](ARCHITECTURE.md#review-lifecycle) describes. Unsupported installations fail closed. Native discovery requires macOS or Linux. On Windows, Pioneer does not copy any extension tree: with extensions enabled, `prepareReviewRuntime` stages nothing, and discovery then fails at once with `[PI_EXTENSION_DISCOVERY_UNSUPPORTED]`. Windows users can pass `--no-extensions` with the required unsandboxed-review acknowledgement.
