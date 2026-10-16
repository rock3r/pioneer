# Reviewing code

## Ask through an agent

With the plugin installed, use ordinary language:

> Ask Pi to review the current working-tree changes with xAI Grok at max thinking. Focus on sandbox escapes and regressions.

> Have Pi compare this implementation with `/path/to/reference-project`, which should be read-only.

> Ask Pi to review the local deployment too; it may access LAN services but must not modify the repository.

The portable Agent Plugin and the Codex and Claude adapters all call `pioneer review`. The CLI owns the shared review implementation.

## Describe the review target

Pioneer grants access to a source directory. For Git-target reviews, the controller collects bounded read-only Git context on every platform. `--source` must be the repository root.

Prefer an explicit `--git` target. Without it, Pioneer infers conservative scopes from Git-target prompts. GitHub pull requests cannot serve as Git targets.

### Working tree

```bash
pioneer review \
  --source "$PWD" \
  --git working-tree \
  --prompt "Review tracked and untracked working-tree changes against HEAD. Ignore unrelated pre-existing files."
```

### Staged changes

```bash
pioneer review \
  --source "$PWD" \
  --git staged \
  --prompt "Review only the staged changes. Check the surrounding code when needed for correctness."
```

### Commit or branch comparison

```bash
pioneer review \
  --source "$PWD" \
  --git commit:abc123 \
  --prompt "Review commit abc123 against its first parent. Report regressions introduced by that commit."
```

```bash
pioneer review \
  --source "$PWD" \
  --git range:origin/main...HEAD \
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

Pioneer creates a private JSONL work log before readiness checks or Pi startup. It immediately prints `[PIONEER_WORK_LOG] ABSOLUTE_PATH` on stderr. Tail the file to inspect review activity.

Five-second `heartbeat` records show the last sanitized Pi event, idle duration, RPC and stderr byte counts, and child process ID. They exclude prompts, model text, and tool content.

Pass `--work-log` to choose an exact create-only destination:

```bash
pioneer review \
  --source "$PWD" \
  --work-log /absolute/path/review.jsonl \
  --prompt "Review this source tree."
```

The target must be absolute, absent, and outside every actor-visible grant. Its parent must be an existing writable directory without a symlink. [Getting started](getting-started.md) lists the default platform log directories.

Windows custom targets inherit their parent ACL. Use the default unless the parent is already private to your user. A write failure or the 16 MiB per-run cap stops the review.

## Persist a report

Pioneer prints the report to stdout and saves every verified final report in a private default directory. It prints `[PIONEER_REPORT] ABSOLUTE_PATH` on stderr.

During execution, that path is a protected reservation. It can contain an ownership marker or report bytes during publication. Read it as a completed durable report only after terminal success. Use `--report` to choose another controller-owned target:

```bash
pioneer review \
  --source "$PWD" \
  --prompt "Review the working tree." \
  --report /absolute/path/to/review.md
```

The report path must be absolute, absent, and outside every source, reference, and writable grant. Pioneer writes it after Pi settles, exits zero, and returns a non-empty report.

Stdout receives the same Markdown. If saving fails, Pioneer keeps the stdout report and exits nonzero with `[REVIEW_REPORT_WRITE_FAILED]`.

Use `--allow-write` only when Pi itself must create artifacts during the review:

```bash
mkdir -p /absolute/path/to/review-artifacts
pioneer review \
  --source "$PWD" \
  --allow-write /absolute/path/to/review-artifacts \
  --prompt "Review the working tree and save supporting analysis under the granted artifact directory."
```

An explicit write grant is a real host capability. It must not overlap the source or a read-only grant.

Pioneer removes private scratch after every run. After a failed new review, it retains a bounded opaque native Pi session only when it proves containment. If stderr includes `[REVIEW_RPC_OUTPUT_LIMIT]` and `[PIONEER_REVIEW_RESUME] TOKEN`, retry exactly:

```bash
pioneer review --resume TOKEN
```

Resume keeps the source, grants, model, thinking, Pi-home, and network policy unchanged. Only timeout, RPC bound, and controller-owned output paths can change. Windows requires a fresh `--allow-unsandboxed-windows` acknowledgement.

Use `--no-resume` for a new review only when the caller explicitly requests ephemeral execution without session retention.

## Choose network scope

- `--network full` is the default and permits public, LAN, and loopback destinations through the proxy.
- `--network public` blocks local and reserved destinations.

Use `full` for local deployment checks. Prefer `public` when the review needs no local services. Pioneer rejects `--network none` because Pi needs access to its configured model provider. Ambient review extension discovery stays disabled.

## Set a timeout

Reviews default to 15 minutes:

```bash
pioneer review \
  --source "$PWD" \
  --timeout-ms 1800000 \
  --prompt "Perform a deep architectural review."
```

On timeout the Pi process is killed and temporary state is removed.
