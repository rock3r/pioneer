# Recoverable reviews design

## Status

Pioneer implements bounded RPC output, private reports, native-session recovery, and exact-token resume. These changes keep the sandbox and strict report-success requirements. This document describes the design, safeguards, and validation plan.

## Problem

The earlier 4 MiB cumulative Pi RPC stdout limit could stop a legitimate high-reasoning review before its final report. Its `UNCLASSIFIED` limit exception did not explain the failure. The design below raises that bound and names the failure.

The controller work log cannot restore that work. It excludes prompts, assistant text and thinking, tool arguments, and tool results. Recovery must preserve completed Pi state without changing those log exclusions.

## Goals

- Give CLI, API, work-log, and skill consumers a clear output-limit failure.
- Set the default cumulative RPC stdout limit to 20 MiB and allow caller overrides through 64 MiB.
- Retain a private native Pi session by default only after strict review completion fails.
- Save every verified final report to a private controller-owned file, including when the caller names no target.
- Resume completed Pi work without Pioneer parsing, replaying, summarizing, or exposing raw model content.
- Keep the sandbox, grant, cleanup, report, and success guarantees.

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

Reviews are resumable by default. Use `--no-resume` to opt out of session retention and launch Pi without a saved session.

`--max-rpc-output-mb` accepts integral MiB from 1 through 64, with a default of 20. The API's `maxRpcOutputBytes` accepts integral bytes from 1 MiB through 64 MiB. `undefined` selects the default. Pioneer rejects zero, negative, fractional, over-limit, and unlimited values.

Every strictly successful review saves its Markdown report in a private default directory through an exclusive create-only reservation. `--report FILE` overrides the target. Saving reports is always enabled. Pioneer reserves the target with a private file containing a random ownership marker. It immediately prints `[PIONEER_REPORT] ABSOLUTE_PATH` to stderr. `ReviewResult.reportPath` identifies the report file.

Default reports are private to the user. Retention keeps the newest 100 inactive files. Reservation markers bind the owner's PID to its OS process-start identity. After the controller exits, retention reclaims abandoned sibling links and inactive post-publication reservation/publication siblings. Transient cleanup failures therefore cannot leave hidden report copies outside the visible bound.

Retention protects siblings with live-controller markers even before their target hard links exist. Empty or partial markers get a one-minute creation grace to protect concurrent reservation setup. Before creating, changing permissions on, or pruning the default directory, Pioneer canonicalizes the prospective target. It checks it against all actor-visible grants and the Pi-home snapshot source.

Pioneer writes only through the still-owned marked reservation inode. A changed target identity fails persistence. A separate random publication lease protects the path from retention while its contents change. If publication fails after writing starts, Pioneer restores the marker. Failure cleanup removes only the inode it still owns, never a replacement path.

Cleanup quarantines candidates before checking ownership. It atomically moves an unowned replacement to a fresh visible `pioneer-preserved` sibling outside retention's cleanup classification. When possible, it then create-only links the inode back to the original path. It never deletes the preserved name.

After syncing the report and rechecking target identity, Pioneer treats handle close and sibling removal as cleanup. Those steps cannot rewrite or invalidate the durable report. `--no-resume` neither creates nor changes permissions on resume storage and does not prune it.

### Resume

```text
pioneer review --resume TOKEN
  [--timeout-ms N]
  [--max-rpc-output-mb N]
  [--report FILE]
  [--work-log FILE]
  [--allow-unsandboxed-windows]
```

The controller generates `TOKEN` as a UUID. Resume reloads the original immutable source directory, grants, prompt, model, thinking, Pi-home selection/includes, and network policy. Callers can change only timeout, bounded output limit, and controller-owned output paths. Every Windows resume requires a fresh `--allow-unsandboxed-windows` acknowledgement.

`ReviewRequest` keeps its new-review shape for source compatibility. Resume has a separate `ResumeReviewRequest` and `resumeReview()` entry point:

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

The collector counts raw stdout bytes before decoding JSONL. When the cumulative count exceeds the selected limit, Pioneer terminates the process tree and completes close/cleanup.

The terminal failure is:

```text
[REVIEW_RPC_OUTPUT_LIMIT] Pi RPC output exceeded the 20 MiB limit
```

The failure excludes raw provider output, Pi diagnostics, prompts, and session content. The work log records `diagnosticCode: REVIEW_RPC_OUTPUT_LIMIT`, `rpcBytes`, `rpcLimitBytes`, and `stderrBytes`. It no longer uses `UNCLASSIFIED` for this failure.

The log also records one `pi_rpc_near_limit` event at each of 75% and 90%. Each contains only `rpcBytes`, `rpcLimitBytes`, and its numeric threshold.

The cap is cumulative. Separate thinking, text, or tool limits would depend on Pi versions and allow untrusted category labels to bypass the bound. The cumulative cap also bounds any unterminated JSONL record held for framing.

After the first 1,000 `thinking_delta`, `toolcall_delta`, and `text_delta` metadata events, Pioneer batches counts by type/subtype into fixed five-second records. Starts, ends, tool lifecycle events, heartbeats, byte totals, and terminal records stay individual. This keeps sanitized logs within the 16 MiB work-log cap for the default 20 MiB RPC budget. With a larger RPC limit, the independent work-log cap can fail first.

## Native session archive

### Rationale

Recovery uses Pi's native session format. The work log excludes the content needed for a summary. Saving raw RPC would duplicate sensitive transcript data in a format Pi cannot resume. Pioneer copies opaque native sessions only between private locations and returns them only to Pi.

Native sessions can contain prompts, assistant thinking, tool arguments, and tool results. They require stronger privacy controls than work logs.

### Layout

The application-data root has sibling `review-resumes` and `reports` directories. macOS uses `~/Library/Application Support/Pioneer/`. Linux and Windows use their per-user application-data locations. POSIX sets the root and default children to mode 0700. Windows callers must ensure that the per-user application-data ACL is private, as with default work logs.

Before archive creation/loading or default report preparation, POSIX checks the lexical and canonical ownership chain. Every directory must belong to the caller or root. Pioneer rejects replaceable group- or world-writable ancestry. It permits only trusted sticky directories that protect a caller-owned child, then makes the Pioneer application directory private. These checks apply even when one output mode skips the other's setup.

XDG and Windows application-data overrides must be absolute. Before creating or loading an archive, Pioneer canonicalizes the root. The whole archive tree must be separate from the source and every actor-visible read/write grant.

```text
review-resumes/<token>/
  manifest.json                 controller-only, mode 0600
  attempts/
    0001/                       active attempt only
      <Pi-native session tree>
    0002/                       resumed attempt
      <copied Pi-native session tree>
```

Every archive directory uses mode 0700 on POSIX. The controller creates the manifest and changes only bounded lifecycle state. It never grants the manifest to the actor. The sandbox receives only the active attempt as an internal writable path, separate from user `--allow-write` grants. It cannot access prior attempts or the archive parent.

The token identifies an archive. It grants no filesystem access. Privacy depends on the private archive root and ACL; token secrecy alone does not protect it.

The manifest stores a schema version, token, scope/policy metadata, exact Pi version, prompt SHA-256 digest, timestamps, and attempt state. It excludes prompt text, reports, RPC streams, credentials, and session content. Pioneer can locate, copy, and size-check session trees. It never parses them.

## Lifecycle

### New review

1. Validate the request and create the work log.
2. Unless the caller selected `--no-resume`, create and validate the private archive before Pi starts. Failure stops launch with `[REVIEW_RESUME_CREATE_FAILED]`.
3. Launch Pi without `--no-session`. Pass a private `--session-dir` for attempt 0001. Keep the Pi configuration snapshot separate and temporary. The saved prompt must exclude run-local scratch paths.
4. Run the sandboxed RPC protocol.
5. On strict success, save the report to the default or explicit target, then delete the archive during cleanup. If saving fails, retain it as `report_delivery_failed` and issue a resume token.
6. On terminal failure, first prove that the whole process tree stopped. Inspect the active attempt for one regular candidate Pi session tree. Retain it only within the 32 MiB/5,000-entry committed-attempt cap. Append this stderr marker after the primary failure:

   ```text
   [PIONEER_REVIEW_RESUME] TOKEN
   ```

   Never write the token to the work log. If containment is unproven, the candidate exceeds the cap, or no regular candidate exists, delete the inactive attempt. Append `[REVIEW_RESUME_UNAVAILABLE]` without a token. `[REVIEW_PROCESS_CONTAINMENT_FAILED]` overrides earlier terminal RPC failures and is never resumable.

Only completed turns already saved by Pi can be recovered. An interrupted assistant turn cannot. Success still requires a complete, non-empty final report.

### Resume

1. Resolve the UUID only below the private archive root. Reject malformed tokens, symlinks, special files, expired archives, and missing state. Acquire the archive lease immediately. Hold it through setup, copying, and execution to prevent concurrent pruning. Reject non-recoverable state. Reject an exact Pi-version mismatch with `[REVIEW_RESUME_PI_VERSION_MISMATCH]`.
2. Revalidate the stored source and grants. The source must be the same canonical directory. Its contents can change; the actor must inspect them again.
3. Read the manifest's committed attempt. Under the archive lease, remove staging attempts left by crashes and ignore newer uncommitted numbered directories. Stage, validate, and atomically promote a symlink-preserving copy into a new attempt directory. Replace the manifest atomically only after promotion. A crash therefore leaves the committed recovery point intact.
4. Launch Pi with the copied session's exact path, without the interactive selector. If Pi rejects a torn or incompatible session, return `[REVIEW_RESUME_SESSION_INVALID]`. Atomically restore the prior committed attempt and retain it through normal expiry. Never fabricate a summary. If the new tree becomes unsafe or exceeds retention bounds, restore the manifest before removing the failed attempt.
5. After loading the session, send this controller-owned prompt to replace all retired per-run locations:

   ```text
   Continue the interrupted independent review. Any earlier run-local scratch
   path is retired; use only this run's execution environment. Reinspect the
   current source where necessary, complete unfinished analysis, and emit only
   the final Markdown review report.
   ```

6. Apply the standard strict completion, report persistence, cleanup, and retention behavior.

## Retention and security

- Retain failed archives for seven days, with at most ten archives. Each archive has 64 MiB and 10,000-entry caps measured only after proven process-tree termination. Reject and prune lifecycle timestamps more than five minutes in the future. A committed attempt can use at most half of each cap, reserving room for the next crash-safe copy.
- Validate the resume root against all actor grants and the Pi-home snapshot source before creation or permission changes. Prune inactive expired archives before creation and after terminal cleanup. Never prune an active lease. Token loading acquires the lease before content validation, releases it on failure, and holds it through resume on success.
- Leases bind PIDs to OS process-start identities. PID reuse cannot preserve or take over an archive. Publication and restoration use create-only hard links to prevent stale takeovers from overwriting new contenders. A losing restoration preserves the displaced inode. Publishers check for live displaced owners and back off before returning acquisition. Pruning tolerates candidates removed after enumeration.
- A crash before proven retention or report-delivery failure leaves the archive `active`. Resume rejects it because Pioneer cannot prove the prior actor stopped. Normal expiry/count pruning eventually removes it.
- Filesystem deletion does not cryptographically erase data.
- Pioneer-generated work-log fields and errors exclude session content, tokens, prompts, thinking, tool inputs/results, credentials, proxy values, and raw provider diagnostics. Loading type-checks every present immutable-scope field without filtering or normalization. Pioneer stores Pi's independently generated Markdown report privately.
- Resume cannot expand source, grant, model, network, or Pi-home authority.
- Archive loading rechecks separation from the stored canonical Pi-home source, reviewed source, and explicit grants.
- Resume validates outputs against the whole private resume store. Report and work-log paths cannot corrupt or expose sibling recovery state.
- The RPC cap applies equally to resumed reviews.
- `--no-resume` keeps the no-session behavior.

## Documentation and skill changes

Implementation must update `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/REVIEW-TRANSPORT.md`, `docs/CLI-REFERENCE.md`, `docs/PI-COMPATIBILITY.md`, `docs/TESTING.md`, the user guide, and the changelog.

The shared `plugins/pioneer/skills/pioneer/SKILL.md` must tell clients to keep stderr and the always-emitted `PIONEER_REPORT` path. When `REVIEW_RPC_OUTPUT_LIMIT` and `PIONEER_REVIEW_RESUME` both appear, clients must run exactly `pioneer review --resume TOKEN`. They must not replace that retry with a fresh review that changes model, sandbox, grants, or network authority.

Tokenless failures keep the existing report-only behavior. Skill evaluations cover output-limit recovery, tokenless failure, `--no-resume`, default-report discovery, and Windows acknowledgement.

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

1. Release the named diagnostic and bounded 20 MiB default with tests and documentation.
2. Add default archive creation and failure retention. Keep `--no-resume` as the privacy opt-out.
3. Add token resume after provider-backed compatibility tests pass on all supported platforms.
4. Release the shared Pioneer skill and evaluation updates with the public CLI contract.
