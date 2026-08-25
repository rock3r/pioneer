import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  computePacketDigest,
  type PreviousFindingV1,
  type PullRequestFileV1,
  type PullRequestPacketV1,
  parsePullRequestPacket,
  validatePacketCompleteness,
} from "../../deep-review/packet.js";
import type { GitHubClient, GitHubPullFile, GitHubReviewComment } from "./client.js";
import { extractMarkerFromBody, type MarkerPayloadV1 } from "./marker.js";

export type GitRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export const SAFE_GIT_CONFIG = [
  "-c",
  `core.hooksPath=${nullDevice()}`,
  "-c",
  "core.pager=",
  "-c",
  "core.editor=true",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.useBuiltinFSMonitor=false",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.gitProxy=",
  "-c",
  `core.attributesFile=${nullDevice()}`,
  "-c",
  "diff.external=",
  "-c",
  "diff.tool=",
  "-c",
  "merge.tool=",
  "-c",
  "credential.helper=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
] as const;

export function gitCollectEnvironment(): NodeJS.ProcessEnv {
  const emptyConfig = nullDevice();
  return {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_ASKPASS: "",
    GIT_EDITOR: "true",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    LANG: "C",
    LC_ALL: "C",
  };
}

function truncateGitOutput(stdout: string): string {
  if (Buffer.byteLength(stdout, "utf8") <= MAX_GIT_OUTPUT_BYTES) return stdout;
  return Buffer.from(stdout, "utf8").subarray(0, MAX_GIT_OUTPUT_BYTES).toString("utf8");
}

export function gitArgsKey(args: readonly string[]): string {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "-c") {
      index += 1;
      continue;
    }
    normalized.push(arg);
  }
  return normalized.join("\0");
}

export async function runGitCollect(
  gitExecutable: string,
  args: readonly string[],
  cwd: string,
  gitRunner: GitRunner,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await gitRunner(
    gitExecutable,
    [...SAFE_GIT_CONFIG, ...args],
    cwd,
    gitCollectEnvironment(),
  );
  return {
    ...result,
    stdout: truncateGitOutput(result.stdout),
    stderr: truncateGitOutput(result.stderr),
  };
}

export async function resolveLocalHeadSha(
  sourceDir: string,
  gitExecutable: string,
  gitRunner: GitRunner,
): Promise<string> {
  const result = await runGitCollect(gitExecutable, ["rev-parse", "HEAD"], sourceDir, gitRunner);
  if (result.exitCode !== 0) {
    throw new Error(
      `[DEEP_REVIEW_PACKET_INCOMPLETE] local HEAD could not be resolved: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim().toLowerCase();
}

export async function verifyMergeBaseAvailable(
  sourceDir: string,
  baseSha: string,
  headSha: string,
  gitExecutable: string,
  gitRunner: GitRunner,
): Promise<void> {
  for (const sha of [baseSha, headSha]) {
    const objectCheck = await runGitCollect(
      gitExecutable,
      ["cat-file", "-e", `${sha}^{commit}`],
      sourceDir,
      gitRunner,
    );
    if (objectCheck.exitCode !== 0) {
      throw new Error(`[DEEP_REVIEW_PACKET_INCOMPLETE] missing commit object ${sha}`);
    }
  }
  const mergeBase = await runGitCollect(
    gitExecutable,
    ["merge-base", baseSha, headSha],
    sourceDir,
    gitRunner,
  );
  if (mergeBase.exitCode !== 0 || mergeBase.stdout.trim().length === 0) {
    throw new Error("[DEEP_REVIEW_PACKET_INCOMPLETE] merge base unavailable for base/head SHAs");
  }
}

export interface GitChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: PullRequestFileV1["status"];
  readonly patch?: string;
  readonly contentKind: "text" | "binary";
  readonly additions: number;
  readonly deletions: number;
}

export async function collectGitChangedFiles(
  sourceDir: string,
  baseSha: string,
  headSha: string,
  gitExecutable: string,
  gitRunner: GitRunner,
): Promise<readonly GitChangedFile[]> {
  const nameStatus = await runGitCollect(
    gitExecutable,
    ["diff", "--name-status", `${baseSha}...${headSha}`],
    sourceDir,
    gitRunner,
  );
  if (nameStatus.exitCode !== 0) {
    throw new Error(
      `[DEEP_REVIEW_PACKET_INCOMPLETE] git diff --name-status failed: ${nameStatus.stderr.trim()}`,
    );
  }

  const entries = parseNameStatus(nameStatus.stdout);
  const files: GitChangedFile[] = [];
  for (const entry of entries) {
    const diff = await runGitCollect(
      gitExecutable,
      ["diff", `${baseSha}...${headSha}`, "--", entry.path],
      sourceDir,
      gitRunner,
    );
    if (diff.exitCode !== 0) {
      throw new Error(
        `[DEEP_REVIEW_PACKET_INCOMPLETE] git diff failed for ${entry.path}: ${diff.stderr.trim()}`,
      );
    }
    const patch = diff.stdout;
    const binary = patch.includes("Binary files") || patch.trim().length === 0;
    files.push({
      path: entry.path,
      ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      status: entry.status,
      contentKind: binary ? "binary" : "text",
      additions: entry.additions,
      deletions: entry.deletions,
      ...(binary ? {} : { patch }),
    });
  }
  return files;
}

interface NameStatusEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: PullRequestFileV1["status"];
  readonly additions: number;
  readonly deletions: number;
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const statusToken = parts[0];
    if (!statusToken) continue;
    const statusCode = statusToken.charAt(0);
    if (statusCode === "R" || statusCode === "C") {
      const previousPath = parts[1];
      const currentPath = parts[2];
      if (!previousPath || !currentPath) continue;
      entries.push({
        status: statusCode === "R" ? "renamed" : "copied",
        previousPath,
        path: currentPath,
        additions: 0,
        deletions: 0,
      });
      continue;
    }
    const filePath = parts[1];
    if (!filePath) continue;
    const status =
      statusCode === "A"
        ? "added"
        : statusCode === "M"
          ? "modified"
          : statusCode === "D"
            ? "deleted"
            : undefined;
    if (!status) {
      throw new Error(
        `[DEEP_REVIEW_PACKET_INCOMPLETE] unrecognized git name-status entry: ${line.trim()}`,
      );
    }
    entries.push({ status, path: filePath, additions: 0, deletions: 0 });
  }
  return entries;
}

function mergeGitAndApiFiles(
  gitFiles: readonly GitChangedFile[],
  apiFiles: readonly GitHubPullFile[],
): PullRequestFileV1[] {
  const apiByPath = new Map(apiFiles.map((file) => [file.path, file]));
  return gitFiles.map((gitFile) => {
    const apiFile = apiByPath.get(gitFile.path);
    const additions = apiFile?.additions ?? gitFile.additions;
    const deletions = apiFile?.deletions ?? gitFile.deletions;
    if (gitFile.contentKind === "binary") {
      return {
        path: gitFile.path,
        ...(gitFile.previousPath ? { previousPath: gitFile.previousPath } : {}),
        status: gitFile.status,
        contentKind: "binary" as const,
        additions,
        deletions,
        patchOmittedReason: "binary" as const,
      };
    }
    return {
      path: gitFile.path,
      ...(gitFile.previousPath ? { previousPath: gitFile.previousPath } : {}),
      status: gitFile.status,
      contentKind: "text" as const,
      additions,
      deletions,
      ...(gitFile.patch !== undefined ? { patch: gitFile.patch } : {}),
    };
  });
}

function markerToPreviousFindingMarker(
  marker: MarkerPayloadV1,
): NonNullable<PreviousFindingV1["marker"]> {
  return {
    findingId: marker.findingId,
    headSha: marker.headSha,
    path: marker.path,
    side: marker.side,
    line: marker.line,
    endLine: marker.endLine,
    category: marker.category,
  };
}

function collectPreviousFindings(
  comments: readonly GitHubReviewComment[],
  trustedAuthorIds: ReadonlySet<string>,
): PreviousFindingV1[] {
  const topLevel = comments.filter((comment) => comment.inReplyToId === undefined);
  const findings: PreviousFindingV1[] = [];

  for (const comment of topLevel) {
    if (!trustedAuthorIds.has(comment.authorId)) continue;
    const extracted = extractMarkerFromBody(comment.body);
    const replies = comments
      .filter((entry) => entry.inReplyToId === comment.id)
      .map((entry) => ({
        commentId: entry.id,
        authorId: entry.authorId,
        authorLogin: entry.authorLogin,
        body: entry.body,
      }));
    findings.push({
      commentId: comment.id,
      authorId: comment.authorId,
      authorLogin: comment.authorLogin,
      body: extracted.visibleBody,
      ...(comment.path ? { path: comment.path } : {}),
      ...(comment.line !== undefined ? { line: comment.line } : {}),
      ...(comment.side ? { side: comment.side } : {}),
      ...(extracted.marker ? { marker: markerToPreviousFindingMarker(extracted.marker) } : {}),
      replies,
    });
  }

  for (const comment of comments) {
    if (comment.inReplyToId !== undefined) continue;
    if (trustedAuthorIds.has(comment.authorId)) continue;
    const replies = comments
      .filter((entry) => entry.inReplyToId === comment.id)
      .map((entry) => ({
        commentId: entry.id,
        authorId: entry.authorId,
        authorLogin: entry.authorLogin,
        body: entry.body,
      }));
    findings.push({
      commentId: comment.id,
      authorId: comment.authorId,
      authorLogin: comment.authorLogin,
      body: comment.body,
      ...(comment.path ? { path: comment.path } : {}),
      ...(comment.line !== undefined ? { line: comment.line } : {}),
      ...(comment.side ? { side: comment.side } : {}),
      replies,
    });
  }

  return findings;
}

const MAX_GIT_COMMAND_MS = 30_000;

export async function defaultGitRunnerCollect(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(executable, [...args], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, MAX_GIT_COMMAND_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_GIT_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_GIT_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

export interface CollectPullRequestPacketOptions {
  readonly sourceDir: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly outputPath: string;
  readonly github: GitHubClient;
  readonly gitExecutable: string;
  readonly gitRunner: GitRunner;
  readonly additionalBotAuthorIds?: readonly string[];
}

export interface CollectPullRequestPacketResult {
  readonly packet: PullRequestPacketV1;
  readonly outputPath: string;
}

export async function collectPullRequestPacket(
  options: CollectPullRequestPacketOptions,
): Promise<CollectPullRequestPacketResult> {
  const {
    sourceDir,
    owner,
    repo,
    pullNumber,
    expectedHeadSha,
    outputPath,
    github,
    gitExecutable,
    gitRunner,
  } = options;

  const actor = await github.getAuthenticatedActor();
  const repository = await github.getRepository(owner, repo);
  const pullRequest = await github.getPullRequest(owner, repo, pullNumber);

  const normalizedExpectedHead = expectedHeadSha.toLowerCase();
  if (pullRequest.headSha.toLowerCase() !== normalizedExpectedHead) {
    throw new Error("[DEEP_REVIEW_HEAD_CHANGED] GitHub pull request head SHA does not match event");
  }

  const localHead = await resolveLocalHeadSha(sourceDir, gitExecutable, gitRunner);
  if (localHead !== normalizedExpectedHead) {
    throw new Error(
      "[DEEP_REVIEW_HEAD_CHANGED] local checkout HEAD does not match expected head SHA",
    );
  }

  await verifyMergeBaseAvailable(
    sourceDir,
    pullRequest.baseSha,
    pullRequest.headSha,
    gitExecutable,
    gitRunner,
  );

  const [commits, apiFiles, reviewComments] = await Promise.all([
    github.listPullCommits(owner, repo, pullNumber),
    github.listPullFiles(owner, repo, pullNumber),
    github.listReviewComments(owner, repo, pullNumber),
  ]);

  const gitFiles = await collectGitChangedFiles(
    sourceDir,
    pullRequest.baseSha,
    pullRequest.headSha,
    gitExecutable,
    gitRunner,
  );
  const files = mergeGitAndApiFiles(gitFiles, apiFiles);

  const trustedAuthorIds = new Set<string>([actor.id, ...(options.additionalBotAuthorIds ?? [])]);
  const previousFindings = collectPreviousFindings(reviewComments, trustedAuthorIds);

  const packetWithoutDigest = {
    schemaVersion: "pioneer-pr-review-packet/v1" as const,
    repository: {
      owner: repository.owner,
      name: repository.name,
      ...(repository.id ? { repositoryId: repository.id } : {}),
    },
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.htmlUrl,
      title: pullRequest.title,
      body: pullRequest.body,
      baseRef: pullRequest.baseRef,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    },
    commits,
    files,
    rules: [] as PullRequestPacketV1["rules"],
    previousFindings,
  };

  const packetDigest = computePacketDigest(packetWithoutDigest);
  const packet = parsePullRequestPacket({ ...packetWithoutDigest, packetDigest });
  validatePacketCompleteness(packet);

  const serialized = `${JSON.stringify(packet, null, 2)}\n`;
  await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });

  return { packet, outputPath };
}
