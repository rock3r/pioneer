# Conventions

## TypeScript

- Use strict TypeScript and ECMAScript modules.
- Prefer small modules with explicit exports.
- Avoid `any`. Parse external data as `unknown` and validate it.
- Model finite states and protocol variants with discriminated unions.
- Inject interfaces for side effects so unit tests can exercise orchestration.
- Give useful error context. Exclude prompts, credentials, and full environment dumps.

## Processes and JSONL

- Use `node:child_process` spawning APIs with `shell: false`.
- Keep executable and arguments separate.
- Treat stdout as protocol-only when running Pi RPC.
- Frame remote procedure calls (RPC) with line-feed-delimited JSON. Buffer incomplete records across chunks.
- Bound stderr, event history, diffs, and stored output to prevent unbounded memory use.
- Make timeout and cancellation behavior explicit and testable.

## Git

- Resolve the repository root before collecting review data.
- Use fixed Git subcommands with validated arguments.
- Distinguish working-tree, staged, untracked, and base-ref review semantics in types and tests.
- Do not mutate the repository as part of review collection.

## Files and naming

- Put production code in `src/`. Put nearby behavior tests in `*.test.ts` and integration fixtures under `test/`.
- Use kebab-case filenames and descriptive domain names.
- Put generated output in `dist/` and coverage output in `coverage/`. Do not commit either directory.
- Record architectural decisions in `docs/` when they establish a durable contract.

## Dependencies

- Prefer Node standard-library APIs for process and filesystem fundamentals.
- Add a dependency only when it reduces a specific protocol, schema, or compatibility risk.
- Commit `package-lock.json` and use `npm ci` in CI.
- Disable dependency lifecycle scripts in continuous integration (CI). Allow an exception only for a proven requirement with a documented risk.
