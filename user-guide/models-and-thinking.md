# Models and thinking

## List configured models

List the exact qualified names Pioneer can select:

```bash
pioneer models
```

If you use a prepared alternative Pi home:

```bash
pioneer models --pi-home /absolute/pi-agent
```

For machine-readable output:

```bash
pioneer models --json
```

Pioneer reads Pi's offline model catalog and skips optional startup network checks. If Pi reports invalid `models.json`, Pioneer rejects the entire list.

## Select a model

Prefer the qualified `provider/model` form shown by Pi:

```bash
pioneer review \
  --source "$PWD" \
  --model xai/grok-4.3 \
  --prompt "Review the implementation under src."
```

An unqualified model ID works only when exactly one configured provider has it. Missing or ambiguous names stop the request before scratch creation. Pioneer prints the configured qualified names and never substitutes another model.

When `--model` is omitted, Pi keeps its configured default.

## Select thinking

Supported thinking levels are:

```text
off minimal low medium high xhigh max
```

Use a separate option:

```bash
--model xai/grok-4.3 --thinking max
```

Or use the model shorthand:

```bash
--model xai/grok-4.3:max
```

An explicit `--thinking` overrides the shorthand. Pi or the selected provider can reject an unsupported level. Pioneer reports that failure and keeps the requested level unchanged.

## Use another Pi home

Pass `--pi-home` when you prepared a dedicated Pi agent directory with different providers, authentication, models, or review skills:

```bash
pioneer review \
  --source "$PWD" \
  --pi-home /absolute/path/to/pi-agent \
  --model provider/model \
  --thinking high \
  --prompt "Review the implementation under src."
```

Pioneer validates the directory and creates a writable run-local copy. The actor uses only the copy as its home.

Review copies include configured Pi skills. Eval copies exclude them so the eval harness controls the skills available to each baseline and candidate arm.

Use repeated `--pi-home-include RELATIVE_PATH` options for extra review paths. Each path must name an exact file or directory relative to the selected Pi home. Includes can select normally skipped packages. Hard exclusions still block sessions, logs, caches, transient directories, and log files. Evals have no include option.
