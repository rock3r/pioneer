# Review transport

## Public interfaces

The executable entry point is:

```text
pioneer review --source DIR --prompt TEXT [options]
```

The TypeScript API is:

```ts
import { runReview } from "@rock3r/pioneer";

const result = await runReview({
  sourceDir: "/absolute/repository",
  prompt: "Review the current changes",
  model: "provider/model",
  thinking: "high",
});
```

`ReviewResult` contains the Markdown `report`, optional effective `model` and `thinking`, a `sandboxed` boolean, and an optional Windows warning.

The CLI prints only the report to stdout. Errors and the Windows warning go to stderr.

## Target semantics

`--source` grants a directory to Pi and sets it as the working directory. Pioneer does not currently collect a Git diff, resolve a base ref, or impose staged/unstaged semantics. Put the intended scope in the prompt, for example:

- “Review all current working-tree changes.”
- “Review commit `abc123` against its first parent.”
- “Review the implementation under `src/auth` against `docs/auth-design.md`.”

Pi uses its configured tools inside the granted source tree to inspect that scope.

## Readiness and model resolution

Readiness runs before scratch creation. Pioneer requires:

1. `pi --version` to succeed;
2. `pi --offline --no-approve --list-models` to return at least one configured model;
3. an explicitly requested model to resolve unambiguously.

A qualified `provider/model` name is matched case-insensitively as a whole. An unqualified model ID is accepted only if exactly one configured provider exposes it. Missing or ambiguous requests fail with the sorted qualified model list.

If Pi returns an empty model list, the controller performs metadata-only `access` checks on the selected Pi agent directory and known configuration filenames. `EACCES` or `EPERM` produces a client-neutral diagnostic explaining that the calling agent's outer terminal sandbox must be escalated or bypassed.

Because policy sandboxes can make `access(2)` succeed while hiding file contents, a recognized outer-agent sandbox environment indicator produces the same conservative result when the model list is empty. Unknown callers can set `PIONEER_OUTER_SANDBOX=1`. The probe never reads configuration contents or reports environment values, and terminal escalation does not disable Pioneer's own review sandbox.

Thinking may be supplied separately with `--thinking`, or as the suffix in `--model provider/model:max`. An explicit `--thinking` value takes precedence over the suffix. Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Pi startup contract

Reviews invoke `pi --mode rpc` and add these defaults unless the caller already supplied an incompatible explicit option:

- `--offline`;
- `--no-session`;
- `--no-approve`;
- `--no-prompt-templates`;
- `--no-themes`;
- `PI_OFFLINE=1`;
- `PI_TELEMETRY=0`.

Offline mode disables Pi's optional startup network activity; it does not prevent the selected provider request once the agent is running.

## RPC framing and completion

The controller writes one LF-delimited request:

```json
{"id":"review","type":"prompt","message":"..."}
```

Stdout is treated as JSONL protocol data. Malformed JSON terminates the process and fails the review. The collector accepts text deltas and final assistant messages from current Pi event variants, including `message_update`, `message_end`, `turn_end`, and `agent_end`. A successful review completes only after `agent_settled` and a non-empty assistant report.

The process is killed on timeout, malformed output, protocol rejection, or output overflow. No shell participates in the RPC launch.

## Path and network construction

After validation, the controller creates a private `/tmp/pir-*` directory containing the writable Pi snapshot, isolated home, temporary directory, and scratch space. Runtime files required by Node, Pi, TLS, and the operating system are added as read-only grants.

Networking is one of `full`, `public`, or `none`; see [SECURITY.md](SECURITY.md). The sandbox receives proxy variables but no direct destination grant.

## Result and cleanup

The report is Pi's final assistant text with surrounding whitespace removed. Pioneer does not rewrite severity, validate file references, or convert the report to JSON. Calling agents should present it as Pi's independent review and may separately add their own analysis.

Proxy servers, Linux bridges, copied Pi state, and scratch data are removed in `finally` cleanup. A persistent report requires an explicit `--allow-write` directory and a prompt telling Pi to write there; stdout remains the canonical returned result.
