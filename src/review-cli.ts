#!/usr/bin/env node
import path from "node:path";
import { runReview } from "./review/runner.js";
import { isThinkingLevel } from "./thinking-level.js";

const REVIEW_USAGE = `Usage:
  pioneer review --source DIR --prompt TEXT [--model PROVIDER/MODEL] [--thinking LEVEL]
    [--pi-home DIR] [--allow-read DIR] [--allow-write DIR]
    [--network full|public|none] [--timeout-ms N] [--allow-unsandboxed-windows]`;

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

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`${REVIEW_USAGE}\n`);
    return;
  }
  const [subcommand, ...rawArgs] = cliArgs;
  if (subcommand !== "review") usage();
  const args = [...rawArgs];
  const sourceDir = takeOption(args, "--source");
  const prompt = takeOption(args, "--prompt");
  const model = takeOption(args, "--model");
  const thinkingText = takeOption(args, "--thinking");
  const piHomeSource = takeOption(args, "--pi-home");
  const allowReadPaths = takeRepeated(args, "--allow-read");
  const allowWritePaths = takeRepeated(args, "--allow-write");
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
    network: networkText as "full" | "public" | "none",
    allowUnsandboxedWindows,
    ...(model === undefined ? {} : { model }),
    ...(thinkingText === undefined ? {} : { thinking: thinkingText }),
    ...(piHomeSource === undefined ? {} : { piHomeSource: path.resolve(piHomeSource) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (result.warning) process.stderr.write(`WARNING: ${result.warning}\n`);
  process.stdout.write(`${result.report}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
