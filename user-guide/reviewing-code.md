# Reviewing code

## Ask through an agent

With the plugin installed, use ordinary language:

> Ask Pi to review the current working-tree changes with xAI Grok at max thinking. Focus on sandbox escapes and regressions.

> Have Pi compare this implementation with `/path/to/reference-project`, which should be read-only.

> Ask Pi to review the local deployment too; it may access LAN services but must not modify the repository.

The portable Agent Plugin and the native Codex and Claude adapters translate the request into the same `pioneer review` CLI. They do not maintain separate review implementations.

## Describe the review target

Pioneer grants a source directory. On Linux, Pi can inspect the requested Git state directly inside
the native sandbox. macOS and opt-in Windows provide read-only source inspection without
controller-side Git execution, so explicit Git-target requests fail closed there. Make the desired scope explicit:

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

## Observe a review in real time

Pioneer creates a private JSONL work log before readiness checks or Pi startup and immediately prints its location as `[PIONEER_WORK_LOG] ABSOLUTE_PATH` on stderr. Tail that file to distinguish a busy review from a stalled controller: five-second `heartbeat` records include the last sanitized Pi event, idle duration, RPC byte count, stderr byte count, and child PID without storing prompts, model text, or tool content.

Pass `--work-log` to choose an exact create-only destination:

```bash
pioneer review \
  --source "$PWD" \
  --work-log /absolute/path/review.jsonl \
  --prompt "Review this source tree."
```

The target must be absolute, absent, outside every actor-visible grant, and beneath an existing writable non-symlink directory. Without the option, Pioneer uses the platform log directory documented in [Getting started](getting-started.md). On Windows, a custom target inherits its parent ACL; use the default unless that parent is already private to the current user. A log write failure or the 16 MiB per-run cap stops the review rather than allowing an unobservable run to continue.

## Persist a report

The canonical result is stdout. Pioneer also persists every verified final report to a private default report directory and prints `[PIONEER_REPORT] ABSOLUTE_PATH` on stderr. While the command is running, that path is a protected reservation and may contain its ownership marker or report bytes being published in place; treat it as the completed durable report only after a successful terminal result. Use `--report` when Pioneer should select a different controller-owned target:

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

The private scratch directory is removed after every run. New reviews also retain a bounded opaque native Pi session after a non-success when containment is proven. If stderr includes both `[REVIEW_RPC_OUTPUT_LIMIT]` and `[PIONEER_REVIEW_RESUME] TOKEN`, retry exactly:

```bash
pioneer review --resume TOKEN
```

Resume keeps the original source, grants, model, thinking, Pi-home, and network policy immutable; only timeout, RPC bound, and controller-owned output paths may change. On Windows, pass a fresh `--allow-unsandboxed-windows` acknowledgement. Use `--no-resume` on a new review only when the caller explicitly wants the ephemeral privacy opt-out.

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
