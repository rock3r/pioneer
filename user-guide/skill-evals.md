# Skill evals

Pioneer prepares and runs isolated actors for skill evaluations. Each case has a `baseline` arm and a `with-skill` arm. Actors can use public network services and explicitly granted tools. They cannot read the source skill, eval definitions, answer keys, sibling arms, or unrelated host files.

Your controller selects the agent protocol, drives Pi RPC, grades output, and combines scores outside the actor sandbox. Pioneer handles preparation and isolation.

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

`skill_name` must be one non-empty portable path component of at most 255 UTF-8 bytes without `/` or `\\`. Pioneer rejects absolute paths, dot names, Windows reserved device names and invalid characters, and names ending in a dot or space. `id` must be an integer unique within the file. `prompt` is required.

`files` is optional and contains paths below the skill directory. Every entry must resolve to a regular file of at most 64 MiB. Pioneer rejects directories, special files such as FIFOs, and larger files before creating output.

Source definitions can contain controller-only fields such as `expected_output` and `expectations`. Pioneer excludes these fields from actor runs.

Actors can see every `files[]` path. Pioneer copies each file into `fixtures/`, lists it in `case.json`, and prints it during `eval run` as `[PIONEER_EVAL_FIXTURES]`. Use filenames and directories that do not reveal the expected finding.

The complete source skill must be free of symbolic links. Generated eval workspaces and `evals/` content are excluded from the with-skill copy. The actor must see only what a developer would see in a real checkout.

## Prepare a battery

Choose a new output directory whose canonical parent is outside the source skill. Pioneer revalidates the created destination before populating it:

```bash
pioneer eval prepare \
  --skill /absolute/path/to/example-skill \
  --evals /absolute/path/to/example-skill/evals/evals.json \
  --output /absolute/path/to/new-eval-battery
```

`eval prepare` rejects paths or contents that reveal the expected finding with `[EVAL_FIXTURE_LEAK]`. This check runs before output-directory creation.

Pioneer splits each path component at camelCase, kebab, snake, and dot word boundaries. It rejects `MOTION-stale.md` and `rough-tier/`. It allows `case` and `fixture` within camelCase or PascalCase names, including `BadgeCase.kt` and `TestFixture.kt`. It checks both `files[]` and staged paths under `fixtures/`.

Pioneer rejects staged text containing `BUG:`, `TODO:`, or `FIXME` in any letter case. It also rejects bare uppercase `TODO` or `XXX`. Bare lowercase `todo` and `xxx` pass. A todo-list app fixture can use these ordinary words.

`TODO-list.md` passes because `todo` is absent from the path denylist. Use repeated `--allow-fixture-name GLOB` options for genuine filename collisions in repository snapshots. This option waives only path checks. [Fixture checks](../docs/EVALS.md#fixture-checks) lists the exact rules.

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

`case.json` contains only the case ID, the actor-ready prompt, the original `source_prompt`, the staged fixtures directory name, and the staged fixture paths. The baseline arm has no candidate skill. The with-skill arm receives a sanitized copy.

### Staged fixture contract

Actors use their run directory as the working directory. Fixtures sit one level below it in `fixtures/`. Pioneer rewrites prompt paths to resolve there: `File: panel.kt` becomes `File: fixtures/panel.kt`. `source_prompt` keeps the original wording. Shared basenames stay unchanged because they cannot identify a unique fixture.

Use `case.json` as the actor prompt source. Actors can list the run directory and `fixtures/` directly. They need no `find`-style search, which the sandbox can refuse to launch.

`pioneer eval prepare` reports the same contract in its JSON output under `actorContract`, and as a `[PIONEER_EVAL_ACTOR_CONTRACT]` stderr line.

## Run an actor

Run your agent adapter once for each arm:

```bash
pioneer eval run \
  --run-dir /absolute/path/to/new-eval-battery/actor-runs/eval-1/baseline \
  --runtime-read /absolute/narrow/path/required/by/the/adapter \
  --deny-read-probe /absolute/path/to/controller/answer-key \
  -- your-agent-adapter --case case.json
```

Repeat with the `with-skill` directory. Before launch, Pioneer prints `[PIONEER_EVAL_ACTOR_CONTRACT]` to stderr with the working directory, `fixtures/`, and `case.json`. It then prints one bounded `[PIONEER_EVAL_FIXTURES]` line per staged file. Pioneer passes the command after `--` as discrete arguments without a shell.

`--run-dir` must identify one narrow writable actor directory. Repeat `--runtime-read` for narrow, read-only tool runtimes that do not overlap it.

Pioneer rejects writable protected-system roots and descendants. It also rejects broad filesystem, sensitive-configuration, home, temporary, and variable-data roots and their canonical aliases. Narrow read-only system runtimes and disposable temporary descendants remain supported.

`--deny-read-probe` is also repeatable. Use it for every controller-side answer key or sensitive reference whose invisibility you want the mandatory preflight to prove.

Three more repeatable options adapt an arm to a skill that drives a local tool:

- `--allow-loopback 127.0.0.1:PORT` lets the actor reach one local port directly, for example a desktop app's HTTP bridge. Every other loopback port stays closed. Only `127.0.0.1` and `localhost` are accepted.
- `--env NAME=VALUE` passes an actor variable, such as a tool configuration directory. Pioneer rejects its reserved names: `PATH`, `HOME`, proxy variables, and `PI_*`/`PIONEER_*`. The log records names and excludes values.
- `--pi-extension PATH` loads a Pi extension file or package directory whose tools the actor may use, for example an MCP adapter. The actor must be Pi. Put the adapter's configuration, such as `mcp.json`, in the run directory and pass its flag on the Pi command:

```bash
pioneer eval run \
  --run-dir /absolute/path/to/battery/actor-runs/eval-1/mcp \
  --allow-loopback 127.0.0.1:8722 \
  --pi-extension /absolute/path/to/pi-mcp-adapter \
  --runtime-read /absolute/path/to/mcp-server-runtime \
  -- pi --no-extensions --mcp-config mcp.json --mode json -p "..."
```

`--no-extensions` on the Pi command excludes enabled user extensions. The explicit `--pi-extension` still loads. Use this option unless an extension supplies the model provider. Staged extensions share a 1 GiB snapshot budget. Any broken user extension fails the run.

On macOS, grant the MCP server executable with `--runtime-read`, for example `--runtime-read ~/.local/bin/uv`. Without that grant, spawning the server fails with `EPERM`.

Use `--stdout-file FILE` for large output. For example, `pi --mode json` repeats each image as base64. Pioneer streams stdout to a file capped at 1 GiB. The in-memory 4 MiB stdout cap then does not apply. `--stderr-file FILE` does the same for stderr. Both files must be absent and outside the run directory.

Pioneer initializes `--pi-extension` only in the actor. At startup, it can use `--env`, run-directory files, Pi arguments such as `--mcp-config`, and `--allow-loopback` ports. Initialization failure stops the run with `[PI_EXTENSION_LOAD_FAILED]` and the extension name.

The eval runner copies required root Pi configuration into an isolated `agentDir` outside the persistent actor run. Pi can write credential lock directories there. The snapshot excludes configured skills and dependency/runtime content. Home/tmp scratch is separate, writable, and temporary. Evals have no Pi-home include option.

Pioneer never mounts the source Pi home. It removes controller launch/probe files and the copied snapshot on every exit path.

For Pi actors, Pioneer adds `--offline`, `--no-session`, `--no-approve`, `--no-extensions`, `--no-prompt-templates`, `--no-themes`, and `--no-skills`. It stages enabled user extensions from the trusted official Pi package and passes them with `--extension`. Their provider registrations remain available. Only `--pi-extension` tools remain enabled.

Put `--no-extensions` on the Pi command to use built-in providers. Explicit `--extension` or `-e` entries still load through the tool-stripping adapter. OAuth refresh uses the broker when the snapshot has OAuth credentials and the package supports the auth adapter.

Your adapter must drive Pi's RPC protocol and deliver `case.json`.

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

## Matrix batteries

Each battery has exactly two arms: `baseline` and `with-skill`. Use separate batteries for other factors, such as current/stale configuration or present/absent files. Do not add a third arm. Keep `CONFIG-stale.md` out of a battery containing `CONFIG.md`, because actors can see every staged path.

Use one battery per cell, with identical case ids, identical prompts, and identical staged filenames. Only the file contents and the controller-owned run manifest differ:

```text
batteries/config-current/actor-runs/eval-10/{baseline,with-skill}/fixtures/CONFIG.md
batteries/config-stale/actor-runs/eval-10/{baseline,with-skill}/fixtures/CONFIG.md
batteries/config-absent/actor-runs/eval-10/{baseline,with-skill}/
```

Compare baseline and with-skill behaviour for each input condition. Also test a missing input that the skill says is present. This checks whether the skill invents conventions from a file that was never staged.

For lower-level mechanics and the verified platform matrix, see [Isolated skill evals](../docs/EVALS.md).
