# Pi extensions in reviews

Reviews, deep reviews, `models`, `doctor`, and strict evals load the operator's enabled user extensions by default. Pioneer allows provider registration and authentication hooks without a provider allowlist. It disables ambient discovery by passing `--no-extensions`, then adds staged paths with `--extension`. It removes extension tools.

To use only built-in providers, pass `--no-extensions` to `review`, `models`, or `doctor`, or `extensions: false` to the review API. Evals use only built-in providers when the Pi command includes `--no-extensions` or `-ne`, or the actor is not the trusted official Pi package. An explicit `--extension` or `-e` still loads through the tool-stripping adapter alongside that opt-out. A trusted package that cannot host the adapter rejects the explicit extension.

Evals use the review's read-only extension snapshot and tool-stripping adapter. Their Pi-home snapshot uses the eval allowlist, excludes `skills/`, and has no `--pi-home-include` option.

OAuth refresh uses the review broker and the eval public network policy when the trusted package can host the auth adapter. This includes built-in-only commands with `--no-extensions`. The broker writes rotated tokens to the source credential file under Pi's lock. It does not copy the write to the actor. If the snapshot contains OAuth credentials but the package cannot host the adapter, the run fails before launch.

## Resolution and staging

The controller resolves resources through the installed official Pi package's `DefaultPackageManager`. It uses global settings and disables project trust. It does not import extension code. Pi determines which package, local-file, and auto-discovered extensions are enabled, including disabled-resource filters. Offline resolution does not install missing packages. Pioneer excludes reviewed-project settings and extensions, consistent with `--no-approve`.

Pioneer copies enabled entry points, package assets, and dependencies as data into a private directory. Npm layouts retain `node_modules` and hoisted dependencies. Local extensions must have a dedicated directory containing their dependencies and assets. Copies cannot exceed 1 GiB or 500,000 entries. Dependency links must resolve inside selected code directories. Pioneer rejects filesystem/home roots, special files, and cycles, and excludes Git metadata and package caches.

Pioneer excludes Pi's private runtime storage by exact location:

- the agent directory's `sessions/` and `logs/` directories;
- regular `.log` files directly in the agent directory;
- session directories set through `PI_CODING_AGENT_SESSION_DIR` or `sessionDir`. A relative setting fails with `PI_SESSION_DIR_RELATIVE`.

If that storage is a link, Pioneer also excludes its canonical target and skips dependency links into it. Pioneer cannot see a `sessionDir` from another project's `.pi/settings.json` or `--session-dir`. It therefore also skips `.jsonl` files, and links to them, whose first parseable line is a Pi session header. See [session history outside known locations](SECURITY.md#session-history-outside-known-locations).

Pioneer copies package dependency directories named `sessions` or `logs` in full. It rejects enabled entry points or code roots inside private session or log storage. Adapt installations with unsupported external runtime dependencies; Pioneer does not grant access to the operator's home.

Staged code has a separate read-only sandbox grant. Pi authentication and configuration use a private writable run-local copy. Native reviews, including built-in-only reviews with `--no-extensions`, refresh OAuth through a controller-owned broker and a separate sandboxed authentication worker. The controller saves rotations under Pi's credential lock. It never copies the review actor's modified credentials back.

Discovery and execution share the configuration and extension snapshot. Pioneer removes both temporary directories after the run. Retained sessions store a SHA-256 digest of the extension snapshot. Before loading a resumed session, Pioneer re-stages and checks the code, dependency bytes, and entry-point order. Changes fail with `REVIEW_RESUME_EXTENSIONS_CHANGED`. Older archives without a digest keep their original built-in-only policy.

## Execution and capabilities

Staging copies dedicated extension directories and installed `node_modules` trees, including ancestor dependencies that Node uses for resolution. It does not trace individual imports. The read-only snapshot can contain sibling package files, including disabled extension code. Pioneer never passes disabled entry points to Pi. Keep private data outside code and dependency directories: enabled extensions can read their contents. Staging does not grant the operator's original home or configuration directories.

Discovery runs extensions in the native sandbox with private HOME/configuration, no reviewed source grant, and authenticated proxy networking. It follows the review's public/full policy. Standalone `models` and `doctor` use the review default of full proxy access.

Discovery uses the same installed Pi CLI and resource loader as execution. An adapter wraps the loader's public `getExtensions` boundary. It rejects load errors and removes user tool registrations before Pi builds its tool registry. It imports the real CLI once, preserving its dispatcher and startup behavior. Each extension initializes once per process. Discovery and review use separate Pi processes.

Ordinary reviews keep the built-in inspection-tool allowlist. Evals can retain tools from a file or package passed with `eval run --pi-extension PATH`. Pioneer stages it read-only like an explicit `--extension` and tells the adapter to trust it. Other extensions lose their tools. The adapter matches trusted files exactly and trusted directories by path containment with a separator. Sibling directories do not match.

`--pi-extension` supplies tools, not models. Only the actor loads it; discovery and the OAuth worker do not. Those processes lack the actor's `--env` values, run-directory grant, Pi arguments, and `--allow-loopback` ports. An adapter that needs those during startup would fail there. Enabled user extensions and explicit `-e` extensions still participate in discovery. If `--pi-extension` initialization fails in the actor, the adapter stops it with `PI_EXTENSION_LOAD_FAILED` and the run exits nonzero.

Extension tools cannot override `read` or add write, shell, or subagent tools outside the policy. Deep review keeps only its controller-selected bundled inspection extension's tools and configured tool-name allowlist. Provider/auth and other lifecycle hooks stay loaded.

OAuth refresh initializes the same enabled extension snapshot in a separate worker. That worker has no model, prompt, session, reviewed source, or review scratch grant. Deep-review capability-profile extensions also participate in discovery and authentication with the actor's validated file grants. Extensions must register provider authentication during initialization, as they do for discovery.

The worker uses the review's network policy and a private Pi configuration copy containing only the requested provider's credential. It discards other configuration changes. See [credential isolation](SECURITY.md#oauth-refresh-in-native-reviews-and-evals).

The OS sandbox enforces the filesystem, process, and network limits. Tool filtering does not isolate JavaScript code. Enabled extensions run in Pi and can read staged credentials, change private scratch, and send allowed network requests. macOS denies subprocess creation; Linux keeps its contained process policy. Extensions that need subprocesses, external files, local daemons, or proxy-unaware networking can fail and need changes.

By default, Node stops after an unhandled promise rejection. `pi-subagents` 0.75 can cause one at session start by spawning a background child without handling failure. For macOS review, discovery, and deep-review actors, the controller passes `--pioneer-no-fork-sandbox`. The adapter handles only unhandled `EPERM` errors from `spawn`. It prints one `[PI_EXTENSION_SUBPROCESS_DENIED]` stderr line, names the npm package from the stack when safe, and lets Pi continue.

The review controller accepts only that exact line format from untrusted stderr. It keeps the package name only if the controller staged that package; otherwise it says "An extension". It records `pi_actor_warning` and returns at most eight distinct warning lines, even on success. Discovery reports the line as a readiness warning in `models`, `doctor`, and reviews. Deep review adds a `pi-extension-subprocess-denied` warning naming the council member.

Other unhandled rejections still stop Pi unless Pi or an extension installs its own handler. Eval actors, Linux actors, and Windows reviews can create processes. The adapter installs no handler there, so a spawn `EPERM` keeps Node's default behavior. Pioneer stages a fixed list of compiled adapter modules beside the snapshot. A unit test checks that every relative import of a staged module is also staged.

## Diagnostics and compatibility

Each deep-review actor has separate configuration and extension snapshots. Its runtime directories and scratch use the selected controller scratch base. A custom base therefore also controls extension-copy disk usage. Large extension trees increase disk use and startup time for each concurrent council member. A shared immutable snapshot is a possible future change. Actor homes must remain separate and writable.

Extension failures use `PI_EXTENSION_RESOLUTION_FAILED`, `PI_EXTENSION_RUNTIME_UNSUPPORTED`, `PI_EXTENSION_SNAPSHOT_LIMIT`, `PI_EXTENSION_DISCOVERY_FAILED`, or `PI_EXTENSION_LOAD_FAILED`. Raw initialization errors can contain credentials, so Pioneer suppresses them.

`PI_EXTENSION_LOAD_FAILED` names failing extensions by their last two path segments. It names missing modules by their path below the innermost `node_modules` and omits other absolute module paths. A reported name must use plain characters. It must have no opaque run of 24 or more letters and digits, credential label, or known credential format.

`PI_EXTENSION_SNAPSHOT_LIMIT` names the exceeded limit and staged totals. Staging also stops if session-history scans in one call open more than 500,000 files or read more than 1 GiB. That error gives scan totals without mentioning the shared content budget. For `eval run --pi-extension`, totals include user and explicit extensions staged first. The message points to `--no-extensions` if enabled user extensions consumed budget, or to explicit `-e` extensions otherwise. Compare the installation with normal Pi and fix the reported dependency or sandbox requirement. Do not change models or disable the sandbox.

The adapter has been tested with Pi 0.80.6 and 1.2.0. Pi 0.99 added `builtin:mcp`, `builtin:codemode`, `builtin:tool-search`, and the `builtin:llama.cpp` provider. Pioneer passes `--no-extensions` with staged paths, so these built-in extensions do not load in reviews or evals.

On Pi 1.0.4+, `--tools` keeps MCP tools unless an entry starts with `mcp__`. Pioneer also passes `--no-mcp` to review, deep-review, and eval Pi actors. Evals receive it after readiness, including deferred extension readiness and `--pi-home`, and after extension staging rebuilds the command. Pioneer preserves actor identity through launcher wrapping; it does not infer identity from argv. Custom non-Pi actors stay unchanged.

A tool-restricted Pi actor with no known launch version fails with `[PI_NO_MCP_VERSION_UNKNOWN]`. The minimum Pi version remains 0.80.6, so Pioneer does not require `--no-mcp` on every supported version. The adapter requires the official Node package and its resource-loader/package-manager contracts. Unsupported installations fail closed. Native discovery requires macOS or Linux. Windows users can pass `--no-extensions` with the required unsandboxed-review acknowledgement.
