# Recoverable reviews design

## Status

Implemented in the recoverable-reviews worktree. The implementation preserves the existing sandbox and strict report-success contract while adding the bounded RPC, private report, native-session recovery, exact-token resume, safeguard, documentation, and skill/evaluation changes described below.

## Problem

Pioneer intentionally bounds untrusted Pi RPC stdout. The present 4 MiB cumulative limit can terminate a legitimate, high-reasoning review before Pi emits a final report. The failure is opaque because its limit exception is recorded as `UNCLASSIFIED`.

The controller-owned work log cannot restore the lost work: it intentionally omits prompt text, assistant text and thinking, tool arguments, and tool results. A safe recovery mechanism must preserve completed Pi state without weakening those log redaction rules.

## Goals

- Make output-limit failures clear to CLI, API, work-log, and skill consumers.
- Raise the default cumulative RPC stdout limit to 20 MiB and permit a bounded caller override through 64 MiB.
- Make new reviews recoverable by default, retaining a private native Pi session only after strict review completion fails.
- Persist every verified final report to a private controller-owned file, even when the caller did not name a report target.
- Resume completed Pi work without parsing, replaying, summarizing, or exposing raw model content through Pioneer.
- Preserve current sandbox, grant, cleanup, report, and success guarantees.

## Non-goals

- Unlimited RPC output.
- Reconstructing a session from a Pioneer work log or raw RPC JSONL.
- Treating partial text as a valid review report.
- Reusing a session with caller-selected source, prompt, model, grant, Pi-home, or network policy.
- Background jobs, session browsing, or cross-machine resume.

## Public contract

### New review

```text
pioneer review --source DIR --prompt TEXT
  [--no-resume]
  [--max-rpc-output-mb N]
  [--report FILE]
  [existing review options]
```

Reviews are resumable by default. `--no-resume` restores today's ephemeral Pi launch and is the explicit privacy opt-out.

`--max-rpc-output-mb` accepts an integral MiB value from 1 through 64 and defaults to 20. The API exposes `maxRpcOutputBytes` as an integral byte value from 1 MiB through 64 MiB. `undefined` selects the default; zero, negative, fractional, over-limit, and unlimited values are rejected.

Every strict-successful review writes its Markdown report through an exclusively
owned create-only reservation in a private default report directory. `--report FILE` overrides
that target; it does not enable persistence. Pioneer first exclusively reserves
the target as a private file containing a random ownership marker. The CLI immediately writes
`[PIONEER_REPORT] ABSOLUTE_PATH` to stderr after opening that reservation, and
`ReviewResult.reportPath` always identifies the report file. Default reports
are private to the current user and pruned to the newest 100 inactive files.
Reservation markers bind the owning PID to its OS process-start identity; a
later retention pass reclaims the sibling link after that controller exits, so
interrupted reviews cannot accumulate permanently active reservations.
The same pass removes inactive post-publication reservation and publication
siblings so a transient cleanup failure cannot retain report content outside
the visible 100-report bound. It protects a sibling whose marker belongs to a
live controller even before the target hard link exists, and grants an
empty/partial marker a one-minute creation grace so concurrent retention cannot
race reservation setup.
Pioneer canonicalizes and validates the prospective default target against all
actor-visible grants and the Pi-home snapshot source before it creates, changes
permissions on, or prunes that directory.

Successful persistence writes through only the still-owned marked reservation
inode and fails if the target identity changes. A separate random publication
lease keeps retention from pruning that path while its contents are changing.
If publication fails after writing begins, Pioneer restores the ownership marker
before returning and failure cleanup removes only the inode it still owns, never
a path another process replaced. After the report is synced and its target
identity is revalidated, handle close and sibling removal are cleanup and cannot
rewrite or invalidate the durable report. `--no-resume` does not create, chmod,
or prune resume storage.

### Resume

```text
pioneer review --resume TOKEN
  [--timeout-ms N]
  [--max-rpc-output-mb N]
  [--report FILE]
  [--work-log FILE]
  [--allow-unsandboxed-windows]
```

`TOKEN` is a controller-generated UUID, not a path. Resume reloads an immutable original scope: source directory, grants, prompt, model, thinking, Pi-home selection/includes, and network policy. It may only override timeout, bounded output limit, and the controller-owned output paths. A Windows resume requires a new, explicit `--allow-unsandboxed-windows` acknowledgement; prior acknowledgement is not durable authority.

The existing exported `ReviewRequest` remains the new-review shape for source compatibility. A separate `ResumeReviewRequest` and `resumeReview()` entry point avoid a breaking replacement with an ambiguous union:

```ts
interface ReviewRequest {
  // Existing required sourceDir and prompt fields.
  readonly resumable?: boolean; // true by default
  readonly maxRpcOutputBytes?: number;
}

interface ResumeReviewRequest {
  readonly resumeToken: string;
  readonly timeoutMs?: number;
  readonly maxRpcOutputBytes?: number;
  readonly reportPath?: string;
  readonly workLogPath?: string;
  readonly allowUnsandboxedWindows?: boolean;
}
```

## Output-limit contract

The collector continues to count raw stdout bytes before decoding JSONL. Once the cumulative count exceeds the selected limit, Pioneer terminates the process tree and completes the existing close/cleanup protocol.

The terminal failure is:

```text
[REVIEW_RPC_OUTPUT_LIMIT] Pi RPC output exceeded the 20 MiB limit
```

It contains no raw provider output, Pi diagnostics, prompt text, or session content. The work log records `diagnosticCode: REVIEW_RPC_OUTPUT_LIMIT`, `rpcBytes`, `rpcLimitBytes`, and `stderrBytes` rather than `UNCLASSIFIED`.

It also records one `pi_rpc_near_limit` event at 75% and one at 90%. Each contains only `rpcBytes`, `rpcLimitBytes`, and its numeric threshold.

The cap remains cumulative. Categorizing thinking, text, or tool traffic would be version-sensitive and leave an untrusted-category bypass. The cumulative cap also bounds an unterminated JSONL record retained for framing.

The work-log budget must not become the earlier effective cap. Pioneer batches
high-volume `thinking_delta`, `toolcall_delta`, and `text_delta` metadata
into fixed five-second, type/subtype-counted records after the first 1,000 such
events. Starts, ends, tool lifecycle events, heartbeats, byte totals, and
terminal records remain individual. This preserves sanitized observability while
keeping the existing 16 MiB work-log cap viable for the 20 MiB default RPC
budget. A caller selecting a larger RPC limit does not receive a guarantee that
the independent work-log cap cannot fail first.

## Native session archive

### Rationale

A synthetic redacted summary is not viable: the work log has deliberately discarded the relevant content, while retaining raw RPC would duplicate sensitive transcript data in a format Pi cannot resume. Pi's native session is the authoritative resume format. Pioneer treats it as opaque data, copying it only between private locations and returning it only to Pi.

Native Pi sessions can hold prompt text, assistant thinking, tool arguments, and tool results. They are not work logs and need stronger privacy treatment.

### Layout

The platform application-data root has sibling `review-resumes` and
`reports` children. On macOS it is under `~/Library/Application Support/Pioneer/`; Linux and Windows use their matching per-user application-data locations. The root and its default children are mode 0700 on POSIX; Windows relies on the per-user application-data ACL, which is a caller precondition just as it is for default work logs. Before archive creation, archive loading, or default report preparation, POSIX validates the lexical and canonical ownership chain, requiring every directory to be caller- or root-owned and rejecting replaceable group- or world-writable ancestry while permitting only trusted sticky directories that protect a caller-owned child, then makes the Pioneer application directory private. This applies even when either output mode bypasses the other setup path.
XDG and Windows application-data overrides must be absolute. Before creating or loading an archive, Pioneer canonicalizes the root and requires the complete archive tree to be disjoint from the source and every actor-visible read/write grant.

```text
review-resumes/<token>/
  manifest.json                 controller-only, mode 0600
  attempts/
    0001/                       active attempt only
      <Pi-native session tree>
    0002/                       resumed attempt
      <copied Pi-native session tree>
```

Every archive directory is mode 0700 on POSIX. The controller creates the manifest, never grants it to the actor, and changes only bounded lifecycle state. The sandbox receives only the active attempt directory as an internal writable path; it is distinct from a user `--allow-write` grant. It cannot access prior attempts or the archive parent. The token is an identifier, not a filesystem-access capability: privacy depends on the private archive root and its ACL, not token secrecy.

The manifest contains a schema version, token, scope/policy metadata, exact Pi version, prompt SHA-256 digest, timestamps, and attempt state. It does not duplicate a prompt, report, RPC stream, credential, or session content. Pioneer may locate, copy, and size-check the session tree, but never parse it.

## Lifecycle

### New review

1. Validate the request and create the work log as today.
2. Unless `--no-resume` was selected, create and validate the private archive before Pi starts. Failure is `[REVIEW_RESUME_CREATE_FAILED]` and stops before actor launch.
3. Launch Pi without `--no-session`, passing a private `--session-dir` for attempt 0001. The Pi configuration snapshot remains separate and ephemeral. The persisted review prompt must not embed a run-local scratch path; scratch remains execution-local state.
4. Run the current sandboxed RPC protocol.
5. On strict success, persist the report to the default or explicit target, then delete the complete archive during cleanup. If report persistence fails, retain the archive with state `report_delivery_failed` and issue a resume token rather than deleting the only recovery input.
6. On a terminal non-success only after Pioneer proves the complete process tree stopped, inspect the active attempt for one regular candidate Pi session tree. If it is within the 32 MiB/5,000-entry committed-attempt cap, retain the archive and append this stderr marker after the primary failure:

   ```text
   [PIONEER_REVIEW_RESUME] TOKEN
   ```

   The token is never written to the work log. If containment is unproven, the candidate exceeds the cap, or no regular candidate exists, delete the inactive attempt, append `[REVIEW_RESUME_UNAVAILABLE]`, and do not issue a token. In particular, `[REVIEW_PROCESS_CONTAINMENT_FAILED]` is never resumable.

An interrupted assistant turn cannot be recovered. Completed turns already written by Pi can be recovered. Neither case changes the rule that only a complete, non-empty final report is successful.

### Resume

1. Resolve the UUID only below the private archive root. Reject malformed tokens, symlinks, special files, expired archives, and missing state. Immediately acquire the archive lease and hold it across all remaining setup, attempt copying, and execution so concurrent pruning cannot remove the recovery point. Then reject a non-recoverable state or exact Pi-version mismatch with `[REVIEW_RESUME_PI_VERSION_MISMATCH]`.
2. Revalidate the stored source and grants. The source must remain the same canonical directory. Contents can have changed; the actor must re-inspect them.
3. Read the manifest's committed attempt, remove crash-left staging attempts while holding the archive lease, ignore any newer uncommitted numbered directory left by a controller crash, and stage, validate, and atomically promote a symlink-preserving copy into a new attempt directory before launch. The manifest is atomically replaced only after promotion, which makes each retry non-destructive and crash-consistent.
4. Launch Pi with the copied session selected by exact path, never through Pi's interactive selector. If Pi rejects a torn or incompatible native session, return `[REVIEW_RESUME_SESSION_INVALID]`, atomically restore the prior committed attempt, retain that prior archive through normal expiry, and do not fabricate a summary.
   If the new attempt's session tree becomes unsafe or exceeds retention bounds, atomically restore the manifest to the prior committed attempt before removing the failed attempt, so the earlier recovery point remains usable.
5. Send this controller-owned continuation prompt after the session loads. It explicitly supersedes all retired per-run locations:

   ```text
   Continue the interrupted independent review. Any earlier run-local scratch
   path is retired; use only this run's execution environment. Reinspect the
   current source where necessary, complete unfinished analysis, and emit only
   the final Markdown review report.
   ```

6. Apply the standard strict completion, report persistence, cleanup, and retention behavior.

## Retention and security

- Retain unsuccessful archives for seven days; retain at most ten, with 64 MiB and 10,000-entry caps per archive measured only after proven process-tree termination. A committed attempt may consume at most half of each archive cap, reserving enough capacity for the crash-safe copy required by the next resume.
- Validate a prospective resume root against all actor-visible grants and the Pi-home snapshot source before creating or changing permissions on it. Prune only inactive expired archives before creation and after terminal cleanup; never prune an active lease. Token loading acquires the archive lease before validating any retained contents, releases it on validation failure, and transfers it to the resume lifecycle on success. Leases bind the PID to its OS process-start identity so PID reuse does not preserve or take over an archive, and concurrent pruning tolerates candidates removed after directory enumeration.
- A controller crash after Pi succeeds but before deletion leaves a conservatively resumable archive that expires normally.
- Deletion is ordinary filesystem deletion, not cryptographic erasure.
- Session content, token, prompt, thinking, tool inputs/results, credentials, proxy values, and raw provider diagnostics never enter Pioneer-generated work-log fields or errors. The final report remains Pi's independently generated Markdown and is stored privately.
- Resume cannot expand source, grant, model, network, or Pi-home authority.
- Archive loading rechecks disjointness against the stored canonical Pi-home source as well as source and explicit grants.
- Resume output validation covers the entire private resume store, not only the selected token, so report or work-log paths cannot corrupt or expose sibling recovery state.
- The RPC cap applies equally to resumed reviews.
- `--no-resume` keeps the present no-session behavior.

## Documentation and skill changes

Implementation must update `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/REVIEW-TRANSPORT.md`, `docs/CLI-REFERENCE.md`, `docs/PI-COMPATIBILITY.md`, `docs/TESTING.md`, the user guide, and the changelog.

The shared `plugins/pioneer/skills/pioneer/SKILL.md` must tell clients to preserve stderr and the always-emitted `PIONEER_REPORT` path. When both `REVIEW_RPC_OUTPUT_LIMIT` and `PIONEER_REVIEW_RESUME` appear, it runs exactly `pioneer review --resume TOKEN`. It must forbid replacing the retry with a fresh review that changes model, sandbox, grants, or network authority. Tokenless failures retain the existing report-only behavior. The skill evaluations add output-limit recovery, tokenless failure, `--no-resume`, default-report discovery, and the Windows acknowledgement cases.

## Validation plan

### Unit and contract tests

- Default 20 MiB, valid overrides, invalid/unlimited values, and the 64 MiB maximum.
- Stable limit diagnostic, byte metadata, and exactly-once 75%/90% events without raw content.
- Default report creation, mode/ACL, marker and API path, explicit-path override, retention, and report-write-failure recovery.
- Delta batching proves the 16 MiB work-log cap remains independent of the 20 MiB default RPC cap.
- Archive permissions, UUID validation, manifest integrity, symlink/special-file rejection, size/count limits, leases, pruning, and success deletion.
- Fake-Pi argv: default runs have a private session directory; `--no-resume` has `--no-session`; resumes use an exact copied session path.
- Failure retains a safe token only after proven containment and post-exit size enforcement; success removes it; a prior attempt survives a failed resume.
- Work logs and errors contain neither token nor raw session content.
- Resume rejects altered scope, Pi-version mismatch, and missing renewed Windows acknowledgement, and reinspects a revalidated source.
- A torn native session produces `REVIEW_RESUME_SESSION_INVALID` without parsing or exposing its content.

### Provider-backed integration

- At the supported minimum and tested maximum Pi versions, prove that RPC mode creates a private session, a forced interruption retains it, and a second sandboxed RPC process continues it to a non-empty final report.
- Run this on macOS and Linux.
- Before release, repeat against the then-current upstream Pi version and update the compatibility policy only after review of its session and RPC contract.

## Rollout

1. Ship the explicit diagnostic and 20 MiB bounded default with tests and docs.
2. Add default archive creation and failure retention, retaining `--no-resume` as the privacy escape hatch.
3. Add token resume after provider-backed compatibility evidence on all supported platforms.
4. Update the shared Pioneer skill and its evaluations in the same release as the public CLI contract.
