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
- **Adapter tests** verify MCP schemas and Claude/Codex packaging without duplicating orchestration assertions.

## Required cases

Security-sensitive changes should include negative tests for malformed JSONL, unsupported thinking levels, invalid model IDs, path escapes, invalid refs, oversized output, subprocess failure, timeout, and cancellation isolation as applicable.

Pi-home snapshot changes must test the positive root allowlist, review/eval skill difference, recursive default exclusions, platform case semantics, case-folded selection and symlink-target deduplication, sparse skipped content, exact repeated review includes, overlap accounting, hard exclusions, special files, and broken, escaping, selected, and unselected symlink targets. Eval snapshot tests must also prove the real Pi home cannot overlap actor grants, controller artifacts stay outside the persistent actor run, selected configuration is read-only, writable scratch is separate, and temporary credentials are removed after completion or setup interruption. Snapshot tests must use sparse or mocked oversized fixtures rather than allocating a real gigabyte.

Tests must not read real credential files, contact model providers by default, or depend on the user's current repositories.

## Commands

```bash
npm test
npm run test:watch
npm run lint
npm run typecheck
npm run build
npm run check
```
