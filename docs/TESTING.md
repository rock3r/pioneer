# Testing

## Workflow

Use test-driven development for behavior changes:

1. Add or update the narrowest test that describes the required behavior.
2. Run it and confirm it fails for the intended reason.
3. Implement the minimum change.
4. Rerun the targeted test and confirm it passes.
5. Run `npm run check` before handoff.

## Test layers

- **Unit tests** cover parsing, validation, target selection, state transitions, and prompt/result shaping without subprocesses.
- **Contract tests** use fake Pi and Git executables to exercise JSONL framing, process arguments, failures, timeouts, and cancellation deterministically.
- **Integration tests** may use the installed `pi` and a temporary Git repository. They must be opt-in or skip clearly when Pi/configured models are unavailable.
- **End-to-end tests** in `test/e2e` drive the built CLI as a subprocess against a scripted Pi installation. The scripted actor is a deterministic local script, so no provider credential is ever required. Cases that launch an actor skip when the native sandbox is unavailable; `eval prepare` cases run everywhere. Run them with `npm run test:e2e`, which builds `dist/` first.
- **Adapter tests** verify MCP schemas and Claude/Codex packaging without duplicating orchestration assertions.
- **Deep review tests** cover versioned schemas, consensus gates, council scheduling, GitHub marker/idempotency contracts, and capability-profile validation. End-to-end CLI contract tests cover `pioneer deep-review` and `pioneer github deep-review` without provider credentials.

Global unit setup compiles the Linux network supervisor beside its source. `buildLinuxSandboxArgv` binds that sibling using the same layout as a published installation. Without it, proxied Bubblewrap launches from TypeScript sources fail. Build the artifact during setup; never skip Linux sandbox cases because it is missing.

## Temporary directories

The unit suite runs inside a run-scoped temporary root rather than the operator's temporary
directory. `test/temp-root-setup.ts` creates one short directory per run, every worker adopts
it through `test/support/temp-root-worker.ts`, and teardown removes it. Containment does not
depend on a case remembering to clean up, so a full `npm test` leaves the platform temporary
directory exactly as it found it no matter how a path was created. Teardown fails the run and
names what survived, which is the guarantee; keep the root short, because a Unix socket bound
below it must fit in `sun_path`.

The root contains what a case allocates through the platform temporary directory. It does not automatically contain a controller allocation that picks its own base: `runEvalCommand` defaults its controller scratch to the platform's short shared temporary directory, so a case that drives it should pass `controllerScratchBase` pointing at its own managed directory. `runReview` takes the same option on its request, and the cases that drive `createReviewScratchDirectory` directly already pass a managed base, so the review scratch is contained everywhere the unit suite touches it. No unit case drives a full `runReview`, so nothing exercises that wiring end to end.

Within that root, claim every temporary path through `registerManagedTempPaths()` in
`test/support/temp-dir.ts`, which removes the claimed trees in an `afterEach` hook. Use
`createTempDir(prefix)` for a directory the case creates itself and `reserveTempPath(name)`
for a path the code under test creates. Never remove a temporary tree inline, because the case
still depends on it while it runs. `test/temp-dir-hygiene.test.ts` fails when a unit test calls
`mkdtemp` directly; it duplicates no coverage but attributes a leak to a file, which the
teardown check cannot do.

## Required cases

Security-sensitive changes should include negative tests for malformed JSONL, unsupported thinking levels, invalid model IDs, path escapes, invalid refs, oversized output, subprocess failure, timeout, and cancellation isolation as applicable.

Recoverable-review tests must cover these contracts:

| Area | Required checks |
| --- | --- |
| RPC | Check 20 MiB/64 MiB bounds, stable near-limit diagnostics, and five-second delta batching. |
| Reports | Check private default creation, post-validation replacement, and unspoofable active reservations. |
| Reservation retention | Check abandoned owners, post-publication sidecars, concurrent pre-link reservations, and publication-time protection. |
| Write failure | Check marker restoration and post-sync close failure. |
| Launch | Check `--no-resume` and exact-session arguments. |
| Scope | Check UUID containment, explicit/default cross-token output containment, immutable scope, and exact Pi versions. |
| Session validation | Reject missing, ambiguous, torn, symlinked, and special-file sessions. |
| Archive limits | Check committed-attempt and aggregate byte/entry bounds and crash-left staging reclamation. |
| Leases | Check validation-time and deletion-time acquisition, pruning, and successful archive deletion. |
| Recovery | Preserve prior attempts and report-delivery recovery. Check tokenless failures and renewed Windows acknowledgement. |

Assert that work logs and diagnostics exclude tokens and native session content.

Eval changes require end-to-end regressions for every reported failure mode:

- Actors must reach staged fixtures from the prepared prompt without searching. Test run-directory/`fixtures/` listing and the printed actor contract.
- Pi must create credential locks in the isolated snapshot. Keep source Pi home unchanged and remove the snapshot afterward.
- Stage logs must exclude prompts and credentials. Test injected fast-start flags and the external agent directory.
- Timeouts must stop process trees and preserve partial output.
- Preflight must reject incompatible Pi, missing/unloadable model configuration, and unconfigured requested models before actor launch.
- Actors must not read controller manifests, sibling arms, or source eval definitions.

Preparation tests must reject revealing paths and lowercase `todo:` with `[EVAL_FIXTURE_LEAK]`. Keep todo-list fixtures and `TestFixture.kt` valid. A sparse fixture above 64 MiB must fail with `[EVAL_FIXTURE_TOO_LARGE]`. These failures must create no output.

Runtime regressions use real macOS/Linux sandboxes in CI:

- Spawn children with ignored stdio, `/bin/sh`, and `/usr/bin/git` (#86, #87).
- Reach an allowed loopback port and deny an unlisted port (#88).
- Pass `--env` values without logging them.
- Retain `--pi-extension` tools and strip plain `-e` tools (#89).
- Initialize `--pi-extension` only in the actor when it needs `--env` and a run-directory file (#91).
- Keep explicit `-e` provider discovery working. Fail actor initialization with `PI_EXTENSION_LOAD_FAILED` when required (#91).

Output tests must name stdout overflow, reject actor-visible `--stdout-file`, and stream more than 4 MiB to a valid `--stdout-file`.

Pi-home snapshot changes require checks for:

- the root allowlist, unknown directory-entry types, review/eval skill differences, and recursive default exclusions;
- platform case matching, identity-checked case-folded selection, symlink-target deduplication, and case-fold collisions;
- sparse skipped content, exact repeated includes, overlap accounting, and hard exclusions;
- special files and broken, escaping, selected, or unselected symlink targets.

Eval snapshot tests must deny source-home overlap with any actor grant. Keep controller artifacts outside the persistent run and home/tmp scratch separate. Test credential locks in the isolated writable agent directory. Keep source home unmounted and remove temporary credentials after completion or setup interruption.

Use sparse or mocked oversized fixtures. Do not allocate a real gigabyte.

Extension tests must load dependency resources, including JSON, from source directories named `sessions` or `logs`. Exclude private agent sessions/logs, root `.log` files, configured session directories, and links into them.

Both suites must identify session `.jsonl` files outside known locations by content. Skip or reject links to history and still copy non-session `.jsonl` files.

With smaller mocked limits, count skipped history against scan-file limits and bytes read against scan-byte limits. Pi-home tests must count `.jsonl` link-target checks too.

Mock `copyFile` to make files become history during copying. Both suites must reject changed `.jsonl` files and multiply hard-linked non-`.jsonl` files.

Tests must not read real credential files, contact model providers by default, or depend on the user's current repositories.

## Timeouts and Windows concurrency

macOS and Linux use Vitest's default 5 s `testTimeout`. Windows serializes files with `fileParallelism: false` and `maxWorkers: 1`. Its `testTimeout` and `hookTimeout` are 15 s.

Concurrent workers on slow Windows CI disks caused otherwise-passing tests to time out together. Those jobs reported cumulative test times much longer than elapsed time. The Windows settings address that disk load. They must not hide hangs.

Prefer a per-case timeout with a comment when one test is genuinely long-running (for example two resume-archive creates plus a live-owner lease inspection, or work-log retention that waits on a lock). Do not skip, quarantine, or weaken a test to make the Windows job pass, and do not use a large global timeout to hide a hang.

End-to-end tests keep their own 120 s serial budget in `vitest.e2e.config.ts`.

## Commands

The extension integration uses installed Pi, disposable configuration, and a local fake provider. It never uses operator credentials. Build first. Outside any outer sandbox, run `PIONEER_PI_EXTENSION_INTEGRATION=1 npx vitest run test/pi-extension-integration.test.ts`.

It checks extension-only discovery/execution, disabled/untrusted resources, dependencies, initialization, tool limits, and source/report/credential/code isolation. A single-use OAuth fixture checks concurrent reviews, durable rotations, later refreshes, and preservation of unrelated credentials. It rejects review-agent and worker credential-file tampering.

The legacy adapter test checks that short-lived broker results cannot trigger a second private refresh. Run against both supported Pi endpoints for auth-adapter changes. Normal `npm test` skips this opt-in integration.

Real provider smoke reviews are separate. Use the requested model and existing credentials. Never print credentials.

```bash
npm test
npm run test:e2e
npm run test:watch
npm run lint
npm run typecheck
npm run build
npm run check
```
