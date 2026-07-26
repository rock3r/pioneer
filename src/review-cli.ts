#!/usr/bin/env node
import path from "node:path";
import { runDoctor } from "./doctor.js";
import { runEvalCli } from "./eval-command.js";
import { formatModelCatalog, modelCatalogJson } from "./model-catalog-output.js";
import { PIONEER_VERSION } from "./package-metadata.js";
import { checkPiReadiness } from "./pi-readiness.js";
import { runReview } from "./review/runner.js";
import { isThinkingLevel } from "./thinking-level.js";

const REVIEW_USAGE = `Usage:
  pioneer review --source DIR --prompt TEXT [--model PROVIDER/MODEL] [--thinking LEVEL]
    [--pi-home DIR] [--allow-read DIR] [--allow-write DIR]
    [--report FILE] [--network full|public|none] [--timeout-ms N] [--allow-unsandboxed-windows]
  pioneer doctor
  pioneer models [--pi-home DIR] [--json]
  pioneer eval prepare --skill DIR --evals FILE --output DIR
  pioneer eval install-linux
  pioneer eval run --run-dir DIR [options] -- COMMAND [ARG ...]`;

function usage(): never {
  throw new Error(REVIEW_USAGE);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) usage();
  args.splice(index, 2);
  return value;
}

function takeRepeated(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(path.resolve(value));
  }
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) {
    process.stdout.write(`${PIONEER_VERSION}\n`);
    return;
  }
  if (cliArgs[0] !== "eval" && (cliArgs.includes("--help") || cliArgs.includes("-h"))) {
    process.stdout.write(`${REVIEW_USAGE}\n`);
    return;
  }
  const [subcommand, ...rawArgs] = cliArgs;
  if (subcommand === "eval") {
    await runEvalCli(rawArgs, "pioneer eval");
    return;
  }
  if (subcommand === "doctor") {
    if (rawArgs.length > 0) usage();
    const result = await runDoctor();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.supported) process.exitCode = 1;
    return;
  }
  if (subcommand === "models") {
    const args = [...rawArgs];
    const piHomeSource = takeOption(args, "--pi-home");
    const json = takeFlag(args, "--json");
    if (args.length > 0) usage();
    const environment =
      piHomeSource === undefined
        ? process.env
        : { ...process.env, PI_CODING_AGENT_DIR: path.resolve(piHomeSource) };
    const readiness = await checkPiReadiness({ environment });
    if (!readiness.ready) throw new Error(readiness.errors.join("\n"));
    if (readiness.warning !== undefined) {
      process.stderr.write(`WARNING: ${readiness.warning}\n`);
    }
    const models = readiness.models ?? [];
    process.stdout.write(
      json
        ? `${JSON.stringify(modelCatalogJson(readiness.version ?? "unknown", models), null, 2)}\n`
        : formatModelCatalog(models),
    );
    return;
  }
  if (subcommand !== "review") usage();
  const args = [...rawArgs];
  const sourceDir = takeOption(args, "--source");
  const prompt = takeOption(args, "--prompt");
  const model = takeOption(args, "--model");
  const thinkingText = takeOption(args, "--thinking");
  const piHomeSource = takeOption(args, "--pi-home");
  const allowReadPaths = takeRepeated(args, "--allow-read");
  const allowWritePaths = takeRepeated(args, "--allow-write");
  const reportPath = takeOption(args, "--report");
  const networkText = takeOption(args, "--network") ?? "full";
  const timeoutText = takeOption(args, "--timeout-ms");
  const unsafeIndex = args.indexOf("--allow-unsandboxed-windows");
  const allowUnsandboxedWindows = unsafeIndex >= 0;
  if (unsafeIndex >= 0) args.splice(unsafeIndex, 1);
  const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
  if (
    !sourceDir ||
    !prompt ||
    args.length > 0 ||
    !["full", "public", "none"].includes(networkText) ||
    (thinkingText !== undefined && !isThinkingLevel(thinkingText)) ||
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
  )
    usage();
  const result = await runReview({
    sourceDir: path.resolve(sourceDir),
    prompt,
    allowReadPaths,
    allowWritePaths,
    ...(reportPath === undefined ? {} : { reportPath }),
    network: networkText as "full" | "public" | "none",
    allowUnsandboxedWindows,
    ...(model === undefined ? {} : { model }),
    ...(thinkingText === undefined ? {} : { thinking: thinkingText }),
    ...(piHomeSource === undefined ? {} : { piHomeSource: path.resolve(piHomeSource) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (result.warning) process.stderr.write(`WARNING: ${result.warning}\n`);
  process.stdout.write(`${result.report}\n`);
  if (result.reportWriteError !== undefined) {
    process.stderr.write(`${result.reportWriteError}\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
