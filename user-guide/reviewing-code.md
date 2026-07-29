# Reviewing code

## Ask through an agent

With the plugin installed, use ordinary language:

> Ask Pi to review the current working-tree changes with xAI Grok at max thinking. Focus on sandbox escapes and regressions.

> Have Pi compare this implementation with `/path/to/reference-project`, which should be read-only.

> Ask Pi to review the local deployment too; it may access LAN services but must not modify the repository.

The Codex and Claude plugins translate the request into the same `pioneer review` CLI. They do not maintain separate review implementations.

## Describe the review target

Pioneer grants a source directory. On Linux, Pi can inspect the requested Git state directly inside
the native sandbox. macOS and opt-in Windows provide read-only source inspection without
controller-side Git execution. Make the desired scope explicit:

### Working tree

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review tracked and untracked working-tree changes against HEAD. Ignore unrelated pre-existing files."
```

### Staged changes

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review only the staged changes. Check the surrounding code when needed for correctness."
```

### Commit or branch comparison

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review commit abc123 against its first parent. Report regressions introduced by that commit."
```

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review the changes on this branch compared with origin/main using the merge base."
```

## Add read-only reference material

Use repeated `--allow-read` grants for specifications, sibling repositories, generated APIs, or reference implementations:

```bash
pioneer review \
  --source "$PWD" \
  --allow-read /absolute/path/to/specifications \
  --allow-read /absolute/path/to/reference-project \
  --prompt "Review this implementation against both granted reference directories."
```

Pi cannot see arbitrary neighboring directories. Grant each required directory explicitly.

## Persist a report

The canonical result is stdout. Use `--report` when Pioneer should atomically persist the verified final report outside the sandbox:

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review the working tree." \
  --report /absolute/path/to/review.md
```

The report target must be an absolute path that does not exist yet and is outside every source, reference, and writable grant. Pioneer writes it only after Pi settles, exits zero, and returns a non-empty report. Stdout still receives the same Markdown. If persistence fails, Pioneer preserves that stdout report but exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`.

Use `--allow-write` only when Pi itself must create artifacts during the review:

```bash
mkdir -p /absolute/path/to/review-artifacts
pioneer review \
  --source "$PWD" \
  --allow-write /absolute/path/to/review-artifacts \
  --prompt "Review the working tree and save supporting analysis under the granted artifact directory."
```

An explicit write grant is a real host capability. It must not overlap the source or a read-only grant.

Without `--report`, Pioneer does not persist the canonical report automatically. Its private scratch directory is removed after every run.

## Choose network scope

- `--network full` is the default and permits public, LAN, and loopback destinations through the proxy.
- `--network public` blocks local and reserved destinations.
- `--network none` disables the proxy.

Use `full` when Pi needs to probe a local deployment. Prefer `public` or `none` when local services are irrelevant.

## Set a timeout

Reviews default to 15 minutes:

```bash
pioneer review \
  --source "$PWD" \
  --timeout-ms 1800000 \
  --prompt "Perform a deep architectural review."
```

On timeout the Pi process is killed and temporary state is removed.
