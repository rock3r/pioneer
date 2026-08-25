import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDeepReviewConfig } from "./deep-review/config.js";
import { parsePullRequestPacket } from "./deep-review/packet.js";
import { buildTerminalSummary, deepReviewExitCode } from "./deep-review/result-output.js";
import { runDeepReview } from "./deep-review/runner.js";
import { CliUsageError } from "./diagnostics.js";
import { PIONEER_VERSION } from "./package-metadata.js";

export interface DeepReviewCliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processOutput: DeepReviewCliOutput = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function deepReviewUsage(commandName: string): string {
  return `Usage:
  ${commandName} --source DIR --packet FILE --config FILE [--output FILE] [--work-log FILE] [--scratch-base DIR]`;
}

function usage(commandName: string): never {
  throw new CliUsageError(deepReviewUsage(commandName));
}

function takeOption(args: string[], name: string, commandName: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) usage(commandName);
  args.splice(index, 2);
  return value;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function runDeepReviewCli(
  cliArgs: readonly string[],
  commandName: string,
  output: DeepReviewCliOutput = processOutput,
): Promise<void> {
  if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) {
    output.stdout(`${PIONEER_VERSION}\n`);
    return;
  }
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    output.stdout(`${deepReviewUsage(commandName)}\n`);
    return;
  }

  const args = [...cliArgs];
  const sourceDir = takeOption(args, "--source", commandName);
  const packetPath = takeOption(args, "--packet", commandName);
  const configPath = takeOption(args, "--config", commandName);
  const resultPath = takeOption(args, "--output", commandName);
  const workLogPath = takeOption(args, "--work-log", commandName);
  const scratchBase = takeOption(args, "--scratch-base", commandName);
  if (!sourceDir || !packetPath || !configPath || args.length > 0) usage(commandName);

  const packet = parsePullRequestPacket(await readJsonFile(path.resolve(packetPath)));
  const config = parseDeepReviewConfig(await readJsonFile(path.resolve(configPath)));

  const execution = await runDeepReview({
    sourceDir: path.resolve(sourceDir),
    packet,
    config,
    ...(resultPath === undefined ? {} : { resultPath: path.resolve(resultPath) }),
    ...(workLogPath === undefined ? {} : { workLogPath: path.resolve(workLogPath) }),
    ...(scratchBase === undefined ? {} : { controllerScratchBase: path.resolve(scratchBase) }),
  });

  output.stderr(`[PIONEER_DEEP_REVIEW_WORK_LOG] ${execution.workLogPath}\n`);
  output.stderr(`[PIONEER_DEEP_REVIEW_RESULT] ${execution.resultPath}\n`);
  output.stdout(`${buildTerminalSummary(execution.result)}\n`);
  process.exitCode = deepReviewExitCode(execution.result);
}
