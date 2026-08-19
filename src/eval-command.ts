import path from "node:path";
import { CliUsageError } from "./diagnostics.js";
import { formatEvalActorContract, readPreparedEvalCase } from "./eval-run/actor-contract.js";
import { installLinuxSandboxSupport } from "./eval-run/linux-install.js";
import { runEvalCommand } from "./eval-run/runner.js";
import { prepareEvalBattery } from "./eval-run/setup.js";
import { PIONEER_VERSION } from "./package-metadata.js";

export interface EvalCliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processOutput: EvalCliOutput = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

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

export async function runEvalCli(
  cliArgs: readonly string[],
  commandName: string,
  output: EvalCliOutput = processOutput,
): Promise<void> {
  if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) {
    output.stdout(`${PIONEER_VERSION}\n`);
    return;
  }
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    output.stdout(`${evalUsage(commandName)}\n`);
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
    output.stdout(`${JSON.stringify(prepared, null, 2)}\n`);
    output.stderr(`[PIONEER_EVAL_ACTOR_CONTRACT] ${prepared.actorContract.description}\n`);
    return;
  }

  if (subcommand === "install-linux") {
    if (process.platform !== "linux" || rawArgs.length > 0) usage(commandName);
    await installLinuxSandboxSupport();
    output.stdout("Linux sandbox support installed\n");
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
    const resolvedRunDir = path.resolve(runDir);
    for (const line of formatEvalActorContract(
      resolvedRunDir,
      await readPreparedEvalCase(resolvedRunDir),
    )) {
      output.stderr(`${line}\n`);
    }
    const result = await runEvalCommand(
      {
        runDir: resolvedRunDir,
        command: command as [string, ...string[]],
        runtimeReadPaths,
        ...(piHomeSource === undefined ? {} : { piHomeSource: path.resolve(piHomeSource) }),
      },
      {
        deniedReadProbePaths,
        onWorkLogReady: (logPath) => output.stderr(`[PIONEER_EVAL_WORK_LOG] ${logPath}\n`),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(workLogPath === undefined ? {} : { workLogPath: path.resolve(workLogPath) }),
      },
    );
    output.stdout(result.stdout);
    if (result.warning !== undefined) output.stderr(`WARNING: ${result.warning}\n`);
    output.stderr(result.stderr);
    if (result.signal !== null) {
      output.stderr(`Eval actor terminated by ${result.signal}\n`);
    }
    process.exitCode = result.exitCode;
    return;
  }

  usage(commandName);
}
