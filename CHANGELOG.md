# Changelog

All notable user-facing changes are recorded here. The project follows semantic versioning.

## Unreleased

- Certify Pi `0.85.1` as the newest tested compatibility endpoint after reviewing 0.85.0 and 0.85.1 CLI, RPC, thinking-level, and session/startup contracts, and keep the minimum at `0.80.6`.

## 0.3.2 - 2026-08-30

- Recognize native Windows npm installations of Pi without executing `pi.cmd`: Pioneer validates the bounded generated shim and its declared package entry point, launches the canonical target through its own Node executable with discrete arguments, skips incompatible POSIX and PowerShell sibling shims, and keeps the expected strict-Windows-eval diagnostic in `pioneer doctor`.

## 0.3.1 - 2026-08-30

- Reject `pioneer review --network none` before launch with `[REVIEW_NETWORK_DISABLED]`: a sandboxed Pi review still needs its configured model provider. Use `--network public`, or start a new `--network full` review only when LAN or loopback access is required.
- Make `pioneer doctor` explain that Pi catalog/configuration failures can be caused by an enclosing agent sandbox blocking Pi configuration or lock-file access, while keeping Pioneer's native review/eval actor sandbox intact. The hint is limited to relevant Pi catalog/configuration diagnostics.
- Document that the Pioneer controller always runs outside any enclosing agent sandbox, while its Pi review actor remains sandboxed; synchronize the installed Pioneer skill and troubleshooting guidance.
- Certify Pi `0.84.4` as the newest tested compatibility endpoint after auditing its bundled-RPC runtime and provider-proxy fix, and run the endpoint smoke against the retained minimum and new maximum.

## 0.3.0 - 2026-08-23

- Let API callers place review and eval controller scratch beneath a validated `controllerScratchBase`, while rejecting broad, protected, actor-granted, unstable, or overlong locations and refusing a scratch directory replaced by a symlink after creation.
- Replace the multi-second Windows PowerShell process-start lookup with the canonical system `cscript.exe` and WMI, preserving start-time-based PID-reuse protection while reducing the first lookup on `windows-latest` to well under the five-second target.
- Update the development-only PostCSS lockfile dependency from 8.5.22 to 8.5.26, closing the repository's source-map loading advisory without changing Pioneer's production dependency surface.
- Stop compiling the unused Windows AppContainer prototype in CI and release. Pioneer never selects the helper, the experimental OS API is feature-gated on the tested Windows 11 build, and a compile-only Windows/.NET job was blocking publication without proving isolation. Windows evals still fail closed before actor launch; the in-tree prototype remains a research record.
- Stop the Linux `native sandbox` CI job hanging for 30+ minutes on its apt step. GitHub's Ubuntu runners intermittently serve a degraded `azure.archive.ubuntu.com`; apt falls back to `archive.ubuntu.com` for the release files and then stalls indefinitely on the package indexes, because apt's `Acquire` timeouts only bound an idle socket and a mirror that trickles bytes never trips them. CI and release now share one installer that gives every `apt-get` invocation a hard `timeout(1)` budget plus bounded retries with dpkg recovery, and the step declares `timeout-minutes` instead of inheriting the 360-minute job default. Because every observed stall was the runner's Azure mirror while Ubuntu's canonical archive stayed reachable, a failed attempt also narrows the mirror list before retrying, so the retry changes the conditions instead of picking the same broken host again. The install also drops the unused `apparmor-utils` package, since Pioneer needs only `bwrap` and `apparmor_parser`.
- Stop the bounded eval-timeout regression test from racing interpreter startup. Its 100 ms timeout had to cover the actor booting Node and flushing both pipes, and measured boot-to-first-byte is about 36 ms idle and up to 94 ms under CPU contention, so a loaded machine could consume the whole window and lose the pre-timeout markers the case asserts.
- Keep `npm test` provider-free when configured Pi providers are ready by making the sibling scratch-base regression stop at a mocked Pi-readiness boundary before actor launch.
- Make diagnostic sanitization roughly two orders of magnitude faster on provider text that holds no credential. The credential-label patterns are quadratic in the input length, so a 4 KiB separator-dense error cost about 220 ms even though no redaction was possible. The label scans and the URL-userinfo scans are now skipped when the value cannot contain a credential keyword, an `@`, or a `%`, which removes an untrusted-input CPU cost from the diagnostic path. Redaction behaviour is unchanged, verified by comparing the old and new implementations over ~77,000 generated inputs.
- Document that Linux eval process containment is structural: Bubblewrap runs as PID 1 of the actor's PID namespace, so a descendant holding inherited pipes is destroyed with the run and `[EVAL_PROCESS_CONTAINMENT_FAILED]` is not reachable there, while macOS still detects the leak through the bounded pipe-close grace. `npm run sandbox:smoke` now asserts each platform's own contract, and proves the Linux descendant started and did not outlive the actor, instead of accepting either outcome.
- Document that every Bubblewrap option Pioneer compiles has been available since bubblewrap 0.2.0, so Pioneer intentionally does not probe for a Bubblewrap version; the versions named in the docs are verified configurations, not a floor.
- Fix `npm test` on Linux distributions whose default umask is permissive: the recoverable-review tests created their fake application-data parents with the ambient umask, producing group-writable ancestry that Pioneer correctly rejects. Added a regression test that pins private default-report creation regardless of the caller's umask.
- Restore Linux sandbox coverage in `npm test` by compiling the Linux network supervisor beside its source in the unit-test global setup, so source-mode Bubblewrap launches resolve it exactly as a published install does instead of skipping.
- Record Ubuntu 26.04 LTS (kernel 7.0.0-29-generic, Bubblewrap 0.11.1, restricted unprivileged user namespaces) as a verified eval platform using the supported `eval install-linux` AppArmor profile.
- Make the staged fixture location part of the eval actor contract: `eval prepare` rewrites prompts so referenced fixtures resolve from the actor working directory, keeps the original wording in `case.json`'s `source_prompt`, and reports the contract on stdout and stderr; `eval run` prints the working directory, `fixtures/`, and the bounded staged file list before the actor starts.
- Add credential-free end-to-end eval regression tests (`npm run test:e2e`) that drive the built CLI against a scripted Pi installation for fixture discovery, run-directory listing, credential locks, work-log stages, injected Pi startup flags, process-tree timeouts, fail-closed Pi and model preflight, and controller-material denial.

## 0.2.0 - 2026-08-19

- Collect Git-target review context in the controller with allowlisted read-only Git, explicit `--git` targets, and prompt inference on every platform, including macOS and Windows.
- Make the isolated eval Pi snapshot writable so current Pi can create `auth.json.lock` and `settings.json.lock`, while still leaving the real Pi home unmounted and deleting the snapshot after every run.
- Add controller-owned eval work logs with default platform storage, `--work-log` custom targets, `[PIONEER_EVAL_WORK_LOG]` path discovery, and stage records for snapshot, probe, proxy, and actor launch.
- Make review RPC output bounded at 20 MiB by default and 64 MiB maximum with stable limit diagnostics, near-limit work-log events, and delta batching.
- Persist verified reports privately by default and emit their controller-owned paths; add opt-out `--no-resume`, opaque native Pi session recovery, exact-token immutable-scope resume, archive/containment/torn-session/Pi-version safeguards, fresh Windows acknowledgement, and corresponding skill/evaluation coverage.

## 0.1.8 - 2026-08-15

- Suppress provider-controlled response, assistant-error, and stderr text from review failures, and redact credential-shaped readiness metadata and authenticated URLs before diagnostics reach callers.
- Keep eval control files and copied Pi configuration out of the persistent actor run, mount selected Pi configuration read-only with separate ephemeral writable home/tmp scratch, remove it on every exit path, and apply Pi-home exclusions case-insensitively on macOS and Windows.
- Reject broad, protected-system, or overlapping eval grants, actor-writable Pi package overlaps, unsafe portable `skill_name` path components, and output paths whose canonical parent enters the source skill or changes during creation.
- Fix macOS eval actor launch resolution and process-tree timeout containment while preserving narrow native sandbox grants and bounded diagnostics; reject cyclic, excessively deep, or unterminated env shebang resolution safely.
- Replace recursive Pi-home copying with a selective snapshot MVP: copy the required root configuration and review skills, skip dependency/runtime fluff by default, and support repeated exact-path `--pi-home-include` opt-ins for reviews while preserving hard exclusions, symlink checks, and the 500,000-entry/1 GiB backstops.
- Certify Pi `0.84.2` as the newest tested compatibility endpoint, including tagged-alias model rows, the endpoint matrix, readiness policy, and compatibility documentation.

## 0.1.7 - 2026-08-11

- Add controller-owned, real-time review work logs with platform-standard default storage, `--work-log` custom targets, immediate path discovery, five-second hang-detection heartbeats, sanitized Pi RPC diagnostics, bounded private files, and automatic default-log retention.
- Add an Agent Plugins v1 portable manifest so compatible coding agents can discover Pioneer's existing Agent Skill without a Codex- or Claude-specific package layout.

## 0.1.6 - 2026-08-10

- Refresh the tested Pi compatibility maximum to `0.84.1`, including the release matrix and a regression test for Pi's delta-only RPC updates.
- Require Node.js 22.19.0 for Pi 0.84.1 and align the user-facing compatibility references.
- Fail closed on Pi assistant errors, preserve split UTF-8 RPC output, and bound cumulative RPC output at 4 MiB.

## 0.1.5 - 2026-07-30

- Add a throttled background npm update notice plus `pioneer check-update` and npm-delegated `pioneer update` commands with interactive or scripted changelog/install choices.
- Ensure reviews do not complete until Pi's process and RPC pipes close, with bounded cleanup when descendants retain those pipes.
- Reject Git-target review scopes on macOS and Windows, where source-only tools cannot inspect them.
- Refresh the tested Pi compatibility maximum to `0.83.0`.

## 0.1.4 - 2026-07-26

- Add controller-owned atomic review report output with `pioneer review --report FILE`, including persistence-failure handling and packaged validation of review completion failures.

## 0.1.3 - 2026-07-26

- Refresh the tested Pi compatibility maximum to `0.82.1`.
- Correct Pi compatibility and isolation guidance across the release and user documentation.
- Make `pioneer doctor` the shared review/eval readiness command.
- Unify eval preparation, execution, and Linux setup under `pioneer eval` and remove the separate `pioneer-eval` binary.
- Disable optional Pi extension discovery for review and eval actors and restrict reviews to an allowlist of Pi's built-in inspection tools.
- Fail review transport with stable diagnostics when Pi settles without a report or exits before settling, and document stdout persistence and caller-side watcher boundaries.

## 0.1.2 - 2026-07-24

- Add `pioneer --version` and `pioneer-eval --version`.
- Enforce Pi `0.80.6` as the minimum supported version and warn above the release's tested maximum.
- Test both Pi compatibility endpoints in CI and block releases when the tested maximum is behind npm `latest`.
- Exclude root temporary Pi-home trees and raise the bounded entry budget to 500,000 while retaining extension package dependencies.

## 0.1.1 - 2026-07-23

- Make both CLI `--help` paths succeed without writing usage to stderr.
- Add `pioneer models` with human-readable and schema-versioned JSON output.
- Reject partial model catalogs when Pi reports an invalid `models.json`.
- Support managed Pi installations whose agent-bin Pi launcher is an external symlink without weakening the general escaping-link rejection.
- Replace the standalone README mascot with an optimized Pioneer banner.

## 0.1.0 - 2026-07-23

- Launch as Pioneer, with the `@rock3r/pioneer`, `pioneer`, and `pioneer-eval` distribution identities.
- Add Pi-backed reviews for Codex and Claude Code with explicit model and thinking-level selection through `max`.
- Add early Pi, configuration, and model-readiness diagnostics with stable error IDs and JSON doctor output.
- Enforce read-only review sources plus writable scratch space on macOS and Linux, with configurable extra path grants and networking.
- Add isolated skill-eval runs with public-only egress on macOS and Linux.
- Document Windows as explicit instruction-only review mode; eval runs fail closed while the AppContainer launcher remains experimental.
- Add public package/plugin metadata, cross-platform CI, packed-artifact smoke tests, and gated npm/GitHub release automation.
