import path from "node:path";
import { CliUsageError, sanitizeDiagnostic } from "../../diagnostics.js";
import { PIONEER_VERSION } from "../../package-metadata.js";
import { resolveGitExecutable } from "../../review/git-inspect.js";
import { createFetchGitHubClient } from "./client.js";
import { collectPullRequestPacket, defaultGitRunnerCollect, type GitRunner } from "./collect.js";
import { publishDeepReviewResult, startDeepReviewCheck } from "./publish.js";

export interface GitHubDeepReviewCliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processOutput: GitHubDeepReviewCliOutput = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function githubDeepReviewUsage(commandName: string): string {
  return `Usage:
  ${commandName} start --owner OWNER --repo REPO --head-sha SHA
  ${commandName} collect --source DIR --owner OWNER --repo REPO --pr NUMBER --head-sha SHA --output FILE [--bot-author-id ID ...]
  ${commandName} publish --owner OWNER --repo REPO --pr NUMBER --result FILE --packet FILE --check-run-id ID [--workflow-run-url URL] [--artifact-url URL]`;
}

function usage(commandName: string): never {
  throw new CliUsageError(githubDeepReviewUsage(commandName));
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

function requireOption(value: string | undefined, commandName: string): string {
  if (!value) usage(commandName);
  return value;
}

function readGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "[DEEP_REVIEW_GITHUB_FAILED] GITHUB_TOKEN is required for GitHub adapter commands",
    );
  }
  return token;
}

export interface RunGitHubDeepReviewCliDeps {
  readonly resolveGit?: typeof resolveGitExecutable;
  readonly gitRunner?: GitRunner;
  readonly createClient?: typeof createFetchGitHubClient;
}

export async function runGitHubDeepReviewCli(
  cliArgs: readonly string[],
  commandName: string,
  output: GitHubDeepReviewCliOutput = processOutput,
  deps: RunGitHubDeepReviewCliDeps = {},
): Promise<void> {
  if (cliArgs.length === 1 && (cliArgs[0] === "--version" || cliArgs[0] === "-v")) {
    output.stdout(`${PIONEER_VERSION}\n`);
    return;
  }
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    output.stdout(`${githubDeepReviewUsage(commandName)}\n`);
    return;
  }

  const [subcommand, ...rawArgs] = cliArgs;
  const args = [...rawArgs];
  const resolveGit = deps.resolveGit ?? resolveGitExecutable;
  const gitRunner = deps.gitRunner ?? defaultGitRunnerCollect;
  const createClient = deps.createClient ?? createFetchGitHubClient;
  const token = readGitHubToken();
  const github = createClient({ token });

  if (subcommand === "start") {
    const owner = requireOption(takeOption(args, "--owner", commandName), commandName);
    const repo = requireOption(takeOption(args, "--repo", commandName), commandName);
    const headSha = requireOption(takeOption(args, "--head-sha", commandName), commandName);
    if (args.length > 0) usage(commandName);
    const started = await startDeepReviewCheck({ owner, repo, headSha, github });
    output.stdout(`${JSON.stringify(started, null, 2)}\n`);
    return;
  }

  if (subcommand === "collect") {
    const sourceDir = path.resolve(
      requireOption(takeOption(args, "--source", commandName), commandName),
    );
    const owner = requireOption(takeOption(args, "--owner", commandName), commandName);
    const repo = requireOption(takeOption(args, "--repo", commandName), commandName);
    const pullNumberText = requireOption(takeOption(args, "--pr", commandName), commandName);
    const headSha = requireOption(takeOption(args, "--head-sha", commandName), commandName);
    const outputPath = path.resolve(
      requireOption(takeOption(args, "--output", commandName), commandName),
    );
    const additionalBotAuthorIds = takeRepeatedOption(args, "--bot-author-id", commandName);
    if (args.length > 0) usage(commandName);
    const pullNumber = Number(pullNumberText);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) usage(commandName);
    const gitExecutable = await resolveGit();
    const collected = await collectPullRequestPacket({
      sourceDir,
      owner,
      repo,
      pullNumber,
      expectedHeadSha: headSha,
      outputPath,
      github,
      gitExecutable,
      gitRunner,
      ...(additionalBotAuthorIds.length > 0 ? { additionalBotAuthorIds } : {}),
    });
    output.stdout(
      `${JSON.stringify({ outputPath: collected.outputPath, packetDigest: collected.packet.packetDigest }, null, 2)}\n`,
    );
    return;
  }

  if (subcommand === "publish") {
    const owner = requireOption(takeOption(args, "--owner", commandName), commandName);
    const repo = requireOption(takeOption(args, "--repo", commandName), commandName);
    const pullNumberText = requireOption(takeOption(args, "--pr", commandName), commandName);
    const resultPath = path.resolve(
      requireOption(takeOption(args, "--result", commandName), commandName),
    );
    const packetPath = path.resolve(
      requireOption(takeOption(args, "--packet", commandName), commandName),
    );
    const checkRunId = requireOption(takeOption(args, "--check-run-id", commandName), commandName);
    const workflowRunUrl = takeOption(args, "--workflow-run-url", commandName);
    const artifactUrl = takeOption(args, "--artifact-url", commandName);
    if (args.length > 0) usage(commandName);
    const pullNumber = Number(pullNumberText);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) usage(commandName);
    try {
      const published = await publishDeepReviewResult({
        owner,
        repo,
        pullNumber,
        resultPath,
        packetPath,
        github,
        checkRunId,
        ...(workflowRunUrl ? { workflowRunUrl } : {}),
        ...(artifactUrl ? { artifactUrl } : {}),
      });
      output.stdout(`${JSON.stringify(published, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`${sanitizeDiagnostic(message, [token])}\n`);
      throw error;
    }
    return;
  }

  usage(commandName);
}
