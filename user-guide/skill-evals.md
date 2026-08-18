# Skill evals

Pioneer can prepare and execute the isolated actor half of a skill-creator-style evaluation. Each case gets a baseline arm and a with-skill arm. The actor can use public network services and explicitly granted tools, but it cannot read the source skill, eval definitions, answer keys, sibling arms, or unrelated host files.

This is an advanced workflow. The harness deliberately does not choose an agent protocol, drive Pi RPC, grade outputs, or aggregate scores. Your controller owns those steps outside the actor sandbox.

## Define cases

Place an `evals/evals.json` file inside the skill directory:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "Review the supplied parser fixture and report concrete bugs.",
      "files": ["evals/files/parser.ts"],
      "expected_output": "Controller-only grading guidance",
      "expectations": ["Finds the off-by-one error"]
    }
  ]
}
```

`skill_name` must be one non-empty portable path component of at most 255 UTF-8 bytes without `/` or `\\`; absolute paths, dot names, Windows reserved device names and invalid characters, and names ending in a dot or space are rejected. `id` must be an integer unique within the file. `prompt` is required. `files` is optional and contains paths below the skill directory. Controller-only fields such as `expected_output` and `expectations` may coexist in the source definition, but Pioneer never stages them into an actor run.

The complete source skill must be free of symbolic links. Generated eval workspaces and `evals/` content are excluded from the with-skill copy.

## Prepare a battery

Choose a new output directory whose canonical parent is outside the source skill. Pioneer revalidates the created destination before populating it:

```bash
pioneer eval prepare \
  --skill /absolute/path/to/example-skill \
  --evals /absolute/path/to/example-skill/evals/evals.json \
  --output /absolute/path/to/new-eval-battery
```

The output directory must not already exist. The generated layout is:

```text
new-eval-battery/
├── controller/
│   └── manifest.json
└── actor-runs/
    └── eval-1/
        ├── baseline/
        │   ├── case.json
        │   ├── fixtures/
        │   ├── home/
        │   ├── tmp/
        │   └── work/
        └── with-skill/
            ├── case.json
            ├── fixtures/
            ├── home/
            ├── tmp/
            ├── work/
            └── skills/example-skill/
```

`case.json` contains only the case ID, prompt, and staged fixture paths. The baseline arm has no candidate skill. The with-skill arm receives a sanitized copy.

## Run an actor

Run your agent adapter once for each arm:

```bash
pioneer eval run \
  --run-dir /absolute/path/to/new-eval-battery/actor-runs/eval-1/baseline \
  --runtime-read /absolute/narrow/path/required/by/the/adapter \
  --deny-read-probe /absolute/path/to/controller/answer-key \
  -- your-agent-adapter --case case.json
```

Repeat with the `with-skill` directory. The command after `--` is passed as discrete arguments, not interpreted by a shell. The writable `--run-dir` must identify one narrow actor directory. `--runtime-read` is repeatable, read-only, and intended for narrow non-overlapping tool runtimes. Writable protected-system roots and their descendants, plus broad filesystem, sensitive-configuration, home, temporary, and variable-data roots and their canonical aliases, are rejected; narrow read-only system runtimes and disposable temporary descendants remain supported.

`--deny-read-probe` is also repeatable. Use it for every controller-side answer key or sensitive reference whose invisibility you want the mandatory preflight to prove.

The eval runner uses a fixed selective Pi-home snapshot outside the persistent actor run: required root configuration files are copied into an isolated `agentDir` that is writable so Pi can create lock directories beside credentials, configured skills and dependency/runtime fluff are excluded, writable home/tmp scratch is separate and ephemeral, and no Pi-home include option is available. The source Pi home is never mounted. Controller launch/probe files and the copied snapshot are removed on every exit path. When the actor executable is Pi, Pioneer adds fast-start and isolation flags automatically: `--offline`, `--no-session`, `--no-approve`, `--no-extensions`, `--no-prompt-templates`, `--no-themes`, and `--no-skills`. Driving Pi's RPC protocol and delivering `case.json` remains the adapter's job.

Every run writes a controller-owned work log. Pioneer prints `[PIONEER_EVAL_WORK_LOG] ABSOLUTE_PATH` to stderr as soon as the file exists. Use `--work-log /absolute/path.jsonl` for a create-only custom target, or leave the default `eval-*.jsonl` file in the platform Pioneer evals log directory. The log records stages such as snapshot, probe, proxy, and actor launch; it does not contain prompts, credentials, or proxy URLs.

## Mandatory security preflight

Before the requested actor starts, every run proves that it cannot:

- read or modify a controller-created outside sentinel;
- inherit a host-only secret;
- connect directly to a listening loopback service; or
- read the explicit deny-read probes.

If any probe fails, the actor never starts. There is no unsandboxed fallback.

## Grade outside the sandbox

Capture actor stdout and artifacts, then grade them from the trusted controller against the original expectations. Keep answer keys outside all actor directories. Compare baseline and with-skill results across the same cases and model settings; do not treat a single successful output as evidence that the skill improved behavior.

For lower-level mechanics and the verified platform matrix, see [Isolated skill evals](../docs/EVALS.md).
