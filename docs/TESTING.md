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

## Required cases

Security-sensitive changes should include negative tests for malformed JSONL, unsupported thinking levels, invalid model IDs, path escapes, invalid refs, oversized output, subprocess failure, timeout, and cancellation isolation as applicable.

Recoverable-review changes additionally require tests for the 20 MiB/64 MiB RPC bounds and stable near-limit diagnostics, five-second delta batching, default private report creation, post-validation target replacement, unspoofable active reservations, abandoned-owner and post-publication-sidecar reclamation, concurrent pre-link reservation protection, publication-time retention protection, failed-write reservation restoration, and post-sync close failure, `--no-resume` and exact-session argv, UUID and explicit/default cross-token resume-output containment, immutable scope and Pi-version checks, missing/ambiguous/torn/symlink/special-file session rejection, committed-attempt and aggregate archive size/count bounds, crash-left staging reclamation, lease/pruning behavior including prevalidation and deletion-time lease acquisition, success deletion, prior-attempt preservation, report-delivery recovery, tokenless failures, and renewed Windows acknowledgement. Work logs and diagnostics must be asserted not to contain tokens or native session content.

Eval command changes require end-to-end regression coverage for every reported eval failure mode: staged fixtures reachable from the prepared prompt without a search, run-directory and `fixtures/` listing, the printed actor contract, credential lock creation in the isolated snapshot with the source Pi home unchanged and the snapshot removed, stage work logs free of prompts and credentials, injected Pi fast-start flags with an externalized agent directory, process-tree timeout with preserved partial output, fail-closed preflight for an incompatible Pi CLI, missing or unloadable model configuration, and an unconfigured requested model without any actor launch, plus actor denial of the controller manifest, sibling arm, and source eval definitions.

Pi-home snapshot changes must test the positive root allowlist, review/eval skill difference, recursive default exclusions, platform case semantics, identity-checked case-folded selection and symlink-target deduplication, case-fold collision rejection, sparse skipped content, exact repeated review includes, overlap accounting, hard exclusions, special files, and broken, escaping, selected, and unselected symlink targets. Eval snapshot tests must also prove the real Pi home cannot overlap actor grants, controller artifacts stay outside the persistent actor run, the isolated snapshot agent directory can create Pi credential lock files, writable home/tmp scratch is separate, the source Pi home remains unmounted, and temporary credentials are removed after completion or setup interruption. Snapshot tests must use sparse or mocked oversized fixtures rather than allocating a real gigabyte.

Tests must not read real credential files, contact model providers by default, or depend on the user's current repositories.

## Timeouts and Windows concurrency

`npm test` keeps Vitest's 5 s default `testTimeout` on macOS and Linux. On Windows it serializes files (`fileParallelism: false`, `maxWorkers: 1`) and raises `testTimeout`/`hookTimeout` to 15 s. That is load-dependent filesystem headroom, not a hang budget: Windows CI has timed out many otherwise-passing cases together when workers oversubscribe a slow disk, and the same job reports far more cumulative test time than wall-clock time.

Prefer a per-case timeout with a comment when one test is genuinely long-running (for example two resume-archive creates plus a live-owner lease inspection, or work-log retention that waits on a lock). Do not skip, quarantine, or weaken a test to make the Windows job pass, and do not use a large global timeout to hide a hang.

End-to-end tests keep their own 120 s serial budget in `vitest.e2e.config.ts`.

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
