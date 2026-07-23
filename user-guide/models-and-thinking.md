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

Pioneer uses Pi's offline model catalog, so this command avoids optional startup network checks. It fails instead of returning a partial list when Pi reports that `models.json` is invalid.

## Select a model

Prefer the qualified `provider/model` form shown by Pi:

```bash
pioneer review \
  --source "$PWD" \
  --model xai/grok-4.3 \
  --prompt "Review the working tree."
```

An unqualified model ID works only when exactly one configured provider exposes it. If the name is missing or ambiguous, Pioneer stops before creating scratch state and prints the configured qualified names. It never silently substitutes another model.

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

If both are present, `--thinking` wins. Pi or the selected provider may still reject a level it does not support; Pioneer surfaces that failure rather than lowering the level automatically.

## Use another Pi home

Pass `--pi-home` when you prepared a dedicated Pi agent directory with different providers, authentication, models, or review skills:

```bash
pioneer review \
  --source "$PWD" \
  --pi-home /absolute/path/to/pi-agent \
  --model provider/model \
  --thinking high \
  --prompt "Review the current changes."
```

Pioneer validates that directory, copies it into the run, and makes the copy writable. The original is never used as the actor's home.

Review copies retain configured Pi skills. Eval copies intentionally omit them so the baseline and candidate arms are controlled by the eval harness.
