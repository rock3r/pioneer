#!/usr/bin/env node
import path from "node:path";
import { createDoctorReport } from "./eval-run/doctor-report.js";
import { installLinuxSandboxSupport } from "./eval-run/linux-install.js";
import { strictEvalReadinessErrors } from "./eval-run/platform-readiness.js";
import { runEvalCommand } from "./eval-run/runner.js";
import { prepareEvalBattery } from "./eval-run/setup.js";
import { checkPiReadiness } from "./pi-readiness.js";

const EVAL_USAGE = `Usage:
  pioneer-eval prepare --skill DIR --evals FILE --output DIR
  pioneer-eval doctor
  pioneer-eval install-linux
  pioneer-eval run --run-dir DIR [--pi-home DIR] [--runtime-read PATH] [--deny-read-probe PATH] [--timeout-ms N] -- COMMAND [ARG ...]`;

function usage(): never {
  throw new Error(EVAL_USAGE);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) usage();
  args.splice(index, 2);
  return value;
}

function takeRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`${EVAL_USAGE}\n`);
    return;
  }
  const [subcommand, ...rawArgs] = cliArgs;
  if (subcommand === "prepare") {
    const args = [...rawArgs];
    const skillDir = takeOption(args, "--skill");
    const evalsPath = takeOption(args, "--evals");
    const outputRoot = takeOption(args, "--output");
    if (!skillDir || !evalsPath || !outputRoot || args.length > 0) usage();
    const prepared = await prepareEvalBattery({ skillDir, evalsPath, outputRoot });
    process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    return;
  }

  if (subcommand === "install-linux") {
    if (process.platform !== "linux" || rawArgs.length > 0) usage();
    await installLinuxSandboxSupport();
    process.stdout.write("Linux sandbox support installed\n");
    return;
  }

  if (subcommand === "doctor") {
    if (rawArgs.length > 0) usage();
    const strictErrors = await strictEvalReadinessErrors();
    const pi = await checkPiReadiness();
    const result = createDoctorReport(process.platform, pi, strictErrors);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.supported || result.errors.length > 0) process.exitCode = 1;
    return;
  }

  if (subcommand === "run") {
    const separator = rawArgs.indexOf("--");
    if (separator < 0) usage();
    const args = rawArgs.slice(0, separator);
    const command = rawArgs.slice(separator + 1);
    const runDir = takeOption(args, "--run-dir");
    const piHomeSource = takeOption(args, "--pi-home");
    const runtimeReadPaths = takeRepeatedOption(args, "--runtime-read");
    const deniedReadProbePaths = takeRepeatedOption(args, "--deny-read-probe");
    const timeoutText = takeOption(args, "--timeout-ms");
    const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
    if (
      !runDir ||
      args.length > 0 ||
      command.length === 0 ||
      (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
    )
      usage();
    const result = await runEvalCommand(
      {
        runDir: path.resolve(runDir),
        command: command as [string, ...string[]],
        runtimeReadPaths,
        ...(piHomeSource === undefined ? {} : { piHomeSource: path.resolve(piHomeSource) }),
      },
      { deniedReadProbePaths, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.signal !== null) {
      process.stderr.write(`Eval actor terminated by ${result.signal}\n`);
    }
    process.exitCode = result.exitCode;
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
