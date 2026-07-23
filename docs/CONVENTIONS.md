# Conventions

## TypeScript

- Use strict TypeScript and ECMAScript modules.
- Prefer small modules with explicit exports.
- Avoid `any`. Parse external data as `unknown` and validate it.
- Model finite states and protocol variants with discriminated unions.
- Keep side effects behind injected interfaces so orchestration can be unit tested.
- Include useful context in errors without exposing prompts, credentials, or full environment dumps.

## Processes and JSONL

- Use `node:child_process` spawning APIs with `shell: false`.
- Keep executable and arguments separate.
- Treat stdout as protocol-only when running Pi RPC.
- Frame RPC using LF-delimited JSON. Do not parse arbitrary chunks as complete records.
- Bound stderr, event history, diffs, and stored output to prevent unbounded memory use.
- Make timeout and cancellation behavior explicit and testable.

## Git

- Resolve the repository root before collecting review data.
- Use fixed Git subcommands with validated arguments.
- Distinguish working-tree, staged, untracked, and base-ref review semantics in types and tests.
- Do not mutate the repository as part of review collection.

## Files and naming

- Production code lives in `src/`; tests live next to behavior as `*.test.ts` or under `test/` for integration fixtures.
- Use kebab-case filenames and descriptive domain names.
- Keep generated output in `dist/` and coverage output in `coverage/`; neither is committed.
- Record architectural decisions in `docs/` when they establish a durable contract.

## Dependencies

- Prefer Node standard-library APIs for process and filesystem fundamentals.
- Add dependencies only when they remove meaningful protocol, schema, or interoperability risk.
- Commit `package-lock.json` and use `npm ci` in CI.
- Do not run dependency lifecycle scripts in CI unless a dependency demonstrably requires them and the risk is documented.
