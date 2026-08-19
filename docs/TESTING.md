# Testing

## Workflow

Use test-driven development for behavior changes:

1. Add or update the narrowest test that describes the required behavior.
2. Run it and confirm it fails for the intended reason.
3. Implement the minimum change.
4. Run the targeted test to green.
5. Run `npm run check` before handoff.

## Test layers

- **Unit tests** cover parsing, validation, target selection, state transitions, and prompt/result shaping without subprocesses.
- **Contract tests** use fake Pi and Git executables to exercise JSONL framing, process arguments, failures, timeouts, and cancellation deterministically.
- **Integration tests** may use the installed `pi` and a temporary Git repository. They must be opt-in or skip clearly when Pi/configured models are unavailable.
- **End-to-end tests** in `test/e2e` drive the built CLI as a subprocess against a scripted Pi installation. The scripted actor is a deterministic local script, so no provider credential is ever required. Cases that launch an actor skip when the native sandbox is unavailable; `eval prepare` cases run everywhere. Run them with `npm run test:e2e`, which builds `dist/` first.
- **Adapter tests** verify MCP schemas and Claude/Codex packaging without duplicating orchestration assertions.

The unit suite's global setup compiles the Linux network supervisor beside its source, because `buildLinuxSandboxArgv` binds that compiled sibling exactly as a published install resolves it. Without it every proxied Bubblewrap launch from the TypeScript sources would fail, so Linux sandbox cases must never be skipped for a missing build artifact.

## Temporary directories

The unit suite runs inside a run-scoped temporary root rather than the operator's temporary
directory. `test/temp-root-setup.ts` creates one short directory per run, every worker adopts
it through `test/support/temp-root-worker.ts`, and teardown removes it. Containment does not
depend on a case remembering to clean up, so a full `npm test` leaves the platform temporary
directory exactly as it found it no matter how a path was created. Teardown fails the run and
names what survived, which is the guarantee; keep the root short, because a Unix socket bound
below it must fit in `sun_path`.

Within that root, claim every temporary path through `registerManagedTempPaths()` in
`test/support/temp-dir.ts`, which removes the claimed trees in an `afterEach` hook. Use
`createTempDir(prefix)` for a directory the case creates itself and `reserveTempPath(name)`
for a path the code under test creates. Never remove a temporary tree inline, because the case
still depends on it while it runs. `test/temp-dir-hygiene.test.ts` fails when a unit test calls
`mkdtemp` directly; it duplicates no coverage but attributes a leak to a file, which the
teardown check cannot do.

## Required cases

Security-sensitive changes should include negative tests for malformed JSONL, unsupported thinking levels, invalid model IDs, path escapes, invalid refs, oversized output, subprocess failure, timeout, and cancellation isolation as applicable.

Recoverable-review changes additionally require tests for the 20 MiB/64 MiB RPC bounds and stable near-limit diagnostics, five-second delta batching, default private report creation, post-validation target replacement, unspoofable active reservations, abandoned-owner and post-publication-sidecar reclamation, concurrent pre-link reservation protection, publication-time retention protection, failed-write reservation restoration, and post-sync close failure, `--no-resume` and exact-session argv, UUID and explicit/default cross-token resume-output containment, immutable scope and Pi-version checks, missing/ambiguous/torn/symlink/special-file session rejection, committed-attempt and aggregate archive size/count bounds, crash-left staging reclamation, lease/pruning behavior including prevalidation and deletion-time lease acquisition, success deletion, prior-attempt preservation, report-delivery recovery, tokenless failures, and renewed Windows acknowledgement. Work logs and diagnostics must be asserted not to contain tokens or native session content.

Eval command changes require end-to-end regression coverage for every reported eval failure mode: staged fixtures reachable from the prepared prompt without a search, run-directory and `fixtures/` listing, the printed actor contract, credential lock creation in the isolated snapshot with the source Pi home unchanged and the snapshot removed, stage work logs free of prompts and credentials, injected Pi fast-start flags with an externalized agent directory, process-tree timeout with preserved partial output, fail-closed preflight for an incompatible Pi CLI, missing or unloadable model configuration, and an unconfigured requested model without any actor launch, plus actor denial of the controller manifest, sibling arm, and source eval definitions.

Pi-home snapshot changes must test the positive root allowlist, review/eval skill difference, recursive default exclusions, platform case semantics, identity-checked case-folded selection and symlink-target deduplication, case-fold collision rejection, sparse skipped content, exact repeated review includes, overlap accounting, hard exclusions, special files, and broken, escaping, selected, and unselected symlink targets. Eval snapshot tests must also prove the real Pi home cannot overlap actor grants, controller artifacts stay outside the persistent actor run, the isolated snapshot agent directory can create Pi credential lock files, writable home/tmp scratch is separate, the source Pi home remains unmounted, and temporary credentials are removed after completion or setup interruption. Snapshot tests must use sparse or mocked oversized fixtures rather than allocating a real gigabyte.

Tests must not read real credential files, contact model providers by default, or depend on the user's current repositories.

## Commands

```bash
npm test
npm run test:e2e
npm run test:watch
npm run lint
npm run typecheck
npm run build
npm run check
```
