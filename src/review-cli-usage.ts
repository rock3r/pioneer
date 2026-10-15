export const REVIEW_USAGE = `Usage:
  pioneer review --source DIR --prompt TEXT [--model PROVIDER/MODEL] [--thinking LEVEL]
    [--pi-home DIR] [--pi-home-include RELATIVE_PATH]... [--allow-read DIR] [--allow-write DIR]
    [--git TARGET]... [--report FILE] [--work-log FILE] [--network full|public]
    [--timeout-ms N] [--max-rpc-output-mb N] [--no-resume] [--no-extensions] [--allow-unsandboxed-windows]
  pioneer review --resume TOKEN [--timeout-ms N] [--max-rpc-output-mb N]
    [--report FILE] [--work-log FILE] [--allow-unsandboxed-windows]
  pioneer doctor [--no-extensions]
  pioneer models [--pi-home DIR] [--json] [--no-extensions]
  pioneer check-update
  pioneer update [--changelog] [--yes|-y]
  pioneer eval prepare --skill DIR --evals FILE --output DIR [--allow-fixture-name GLOB]...
  pioneer eval install-linux
  pioneer eval run --run-dir DIR [options] [--work-log FILE] -- COMMAND [ARG ...]
  pioneer deep-review --source DIR --packet FILE --config FILE [--output FILE] [--work-log FILE] [--scratch-base DIR]
  pioneer github deep-review start|collect|publish ...

Commands:
  review        Run a code review through Pi. Resume a retained review with --resume TOKEN.
  doctor        Check Pi configuration and native sandbox support.
  models        List configured Pi models and their thinking levels.
  check-update  Check for a newer Pioneer release.
  update        Install the latest Pioneer release through npm.
  eval          Prepare isolated skill evaluations or run an evaluation actor.
  deep-review   Run a review council from a packet and configuration file.
  github        Collect or publish a GitHub deep review.

On macOS and Linux, Pioneer runs review actors in a native sandbox.
Windows reviews require explicit --allow-unsandboxed-windows approval.
Use pioneer eval --help for evaluation options.`;
