import path from "node:path";
import { CliUsageError } from "./diagnostics.js";
import { installLinuxSandboxSupport } from "./eval-run/linux-install.js";
import { runEvalCommand } from "./eval-run/runner.js";
import { prepareEvalBattery } from "./eval-run/setup.js";
import { PIONEER_VERSION } from "./package-metadata.js";

export function evalUsage(commandName: string): string {
  return `Usage:
  ${commandName} prepare --skill DIR --evals FILE --output DIR
  ${commandName} install-linux
  ${commandName} run --run-dir DIR [--pi-home DIR] [--runtime-read PATH] [--deny-read-probe PATH] [--timeout-ms N] [--work-log FILE] -- COMMAND [ARG ...]`;
}

function usage(commandName: string): never {
  throw new CliUsageError(evalUsage(commandName));
}

function takeOption(args: string[], name: string, commandName: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) usage(commandName);
  args.splice(index, 2);
  return value;
}

function takeRepeatedOption(args: string[], name: string, commandName: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name, commandName);
    if (value === undefined) return values;
    values.push(value);
  }
}

export async function runEvalCli(cliArgs: readonly string[], commandName: string): Promise<void> {
  if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) {
    process.stdout.write(`${PIONEER_VERSION}\n`);
    return;
  }
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`${evalUsage(commandName)}\n`);
    return;
  }
  const [subcommand, ...rawArgs] = cliArgs;
  if (subcommand === "prepare") {
    const args = [...rawArgs];
    const skillDir = takeOption(args, "--skill", commandName);
    const evalsPath = takeOption(args, "--evals", commandName);
    const outputRoot = takeOption(args, "--output", commandName);
    if (!skillDir || !evalsPath || !outputRoot || args.length > 0) usage(commandName);
    const prepared = await prepareEvalBattery({ skillDir, evalsPath, outputRoot });
    process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    return;
  }

  if (subcommand === "install-linux") {
    if (process.platform !== "linux" || rawArgs.length > 0) usage(commandName);
    await installLinuxSandboxSupport();
    process.stdout.write("Linux sandbox support installed\n");
    return;
  }

  if (subcommand === "run") {
    const separator = rawArgs.indexOf("--");
    if (separator < 0) usage(commandName);
    const args = rawArgs.slice(0, separator);
    const command = rawArgs.slice(separator + 1);
    const runDir = takeOption(args, "--run-dir", commandName);
    const piHomeSource = takeOption(args, "--pi-home", commandName);
    const runtimeReadPaths = takeRepeatedOption(args, "--runtime-read", commandName);
    const deniedReadProbePaths = takeRepeatedOption(args, "--deny-read-probe", commandName);
    const timeoutText = takeOption(args, "--timeout-ms", commandName);
    const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
    const workLogPath = takeOption(args, "--work-log", commandName);
    if (
      !runDir ||
      args.length > 0 ||
      command.length === 0 ||
      (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
    )
      usage(commandName);
    const result = await runEvalCommand(
      {
        runDir: path.resolve(runDir),
        command: command as [string, ...string[]],
        runtimeReadPaths,
        ...(piHomeSource === undefined ? {} : { piHomeSource: path.resolve(piHomeSource) }),
      },
      {
        deniedReadProbePaths,
        onWorkLogReady: (logPath) => process.stderr.write(`[PIONEER_EVAL_WORK_LOG] ${logPath}\n`),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(workLogPath === undefined ? {} : { workLogPath: path.resolve(workLogPath) }),
      },
    );
    process.stdout.write(result.stdout);
    if (result.warning !== undefined) process.stderr.write(`WARNING: ${result.warning}\n`);
    process.stderr.write(result.stderr);
    if (result.signal !== null) {
      process.stderr.write(`Eval actor terminated by ${result.signal}\n`);
    }
    process.exitCode = result.exitCode;
    return;
  }

  usage(commandName);
}
