export const REVIEW_USAGE = `Usage:
  pioneer review --source DIR --prompt TEXT [--model PROVIDER/MODEL] [--thinking LEVEL]
    [--pi-home DIR] [--pi-home-include RELATIVE_PATH]... [--allow-read DIR] [--allow-write DIR]
    [--git TARGET]... [--report FILE] [--work-log FILE] [--network full|public|none]
    [--timeout-ms N] [--max-rpc-output-mb N] [--no-resume] [--allow-unsandboxed-windows]
  pioneer review --resume TOKEN [--timeout-ms N] [--max-rpc-output-mb N]
    [--report FILE] [--work-log FILE] [--allow-unsandboxed-windows]
  pioneer doctor
  pioneer models [--pi-home DIR] [--json]
  pioneer check-update
  pioneer update [--changelog] [--yes|-y]
  pioneer eval prepare --skill DIR --evals FILE --output DIR
  pioneer eval install-linux
  pioneer eval run --run-dir DIR [options] [--work-log FILE] -- COMMAND [ARG ...]
  pioneer deep-review --source DIR --packet FILE --config FILE [--output FILE] [--work-log FILE] [--scratch-base DIR]
  pioneer github deep-review start|collect|publish ...`;
