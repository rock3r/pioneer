import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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
const MAX_RULE_CONTENT_BYTES = 64 * 1024;

export const TRUSTED_REPOSITORY_RULE_PATHS = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/ARCHITECTURE.md",
  "docs/CONVENTIONS.md",
  "docs/SECURITY.md",
  "docs/TESTING.md",
] as const;

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

const SHA1_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHA256_EMPTY_TREE = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

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

function assertGitOutputWithinLimit(bytes: number, stream: "stdout" | "stderr"): void {
  if (bytes > MAX_GIT_OUTPUT_BYTES) {
    throw new Error(
      `[DEEP_REVIEW_PACKET_INCOMPLETE] git ${stream} exceeds ${MAX_GIT_OUTPUT_BYTES} byte limit`,
    );
  }
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
    if (arg === "--attr-source") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-pager" ||
      arg === "--literal-pathspecs" ||
      arg === "--text" ||
      arg === "--no-ext-diff" ||
      arg === "--no-textconv" ||
      arg === "--no-color"
    ) {
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
  assertGitOutputWithinLimit(Buffer.byteLength(result.stdout, "utf8"), "stdout");
  assertGitOutputWithinLimit(Buffer.byteLength(result.stderr, "utf8"), "stderr");
  return result;
}

async function resolveEmptyTree(
  sourceDir: string,
  gitExecutable: string,
  gitRunner: GitRunner,
): Promise<string> {
  const result = await runGitCollect(
    gitExecutable,
    ["rev-parse", "--show-object-format"],
    sourceDir,
    gitRunner,
  );
  if (result.exitCode !== 0) return SHA1_EMPTY_TREE;
  const format = result.stdout.trim();
  return format === "sha256" ? SHA256_EMPTY_TREE : SHA1_EMPTY_TREE;
}

async function runGitDiffCollect(
  gitExecutable: string,
  args: readonly string[],
  cwd: string,
  emptyTree: string,
  gitRunner: GitRunner,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (args[0] !== "diff") {
    throw new Error("[DEEP_REVIEW_PACKET_INCOMPLETE] internal git diff invocation is invalid");
  }
  const result = await gitRunner(
    gitExecutable,
    [
      "--no-pager",
      "--literal-pathspecs",
      "--attr-source",
      emptyTree,
      ...SAFE_GIT_CONFIG,
      "-c",
      `attr.tree=${emptyTree}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      ...args.slice(1),
    ],
    cwd,
    gitCollectEnvironment(),
  );
  assertGitOutputWithinLimit(Buffer.byteLength(result.stdout, "utf8"), "stdout");
  assertGitOutputWithinLimit(Buffer.byteLength(result.stderr, "utf8"), "stderr");
  return result;
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
  const emptyTree = await resolveEmptyTree(sourceDir, gitExecutable, gitRunner);
  const nameStatus = await runGitDiffCollect(
    gitExecutable,
    ["diff", "--name-status", "-z", `${baseSha}...${headSha}`],
    sourceDir,
    emptyTree,
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
    const diff = await runGitDiffCollect(
      gitExecutable,
      ["diff", `${baseSha}...${headSha}`, "--", entry.path],
      sourceDir,
      emptyTree,
      gitRunner,
    );
    if (diff.exitCode !== 0) {
      throw new Error(
        `[DEEP_REVIEW_PACKET_INCOMPLETE] git diff failed for ${entry.path}: ${diff.stderr.trim()}`,
      );
    }
    const patch = diff.stdout;
    const binary = isGitBinaryPatch(patch);
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

export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  if (output.length === 0) return entries;
  const fields = output.split("\0").filter((field) => field.length > 0);
  for (let index = 0; index < fields.length; ) {
    const statusToken = fields[index];
    if (statusToken === undefined) break;
    const statusCode = statusToken.charAt(0);
    if (statusCode === "R" || statusCode === "C") {
      const previousPath = fields[index + 1];
      const currentPath = fields[index + 2];
      if (!previousPath || !currentPath) {
        throw new Error(
          `[DEEP_REVIEW_PACKET_INCOMPLETE] incomplete git rename/copy name-status entry`,
        );
      }
      entries.push({
        status: statusCode === "R" ? "renamed" : "copied",
        previousPath,
        path: currentPath,
        additions: 0,
        deletions: 0,
      });
      index += 3;
      continue;
    }
    const filePath = fields[index + 1];
    if (!filePath) {
      throw new Error(`[DEEP_REVIEW_PACKET_INCOMPLETE] incomplete git name-status entry`);
    }
    const status =
      statusCode === "A"
        ? "added"
        : statusCode === "M" || statusCode === "T"
          ? "modified"
          : statusCode === "D"
            ? "deleted"
            : undefined;
    if (!status) {
      throw new Error(
        `[DEEP_REVIEW_PACKET_INCOMPLETE] unrecognized git name-status entry: ${statusToken}`,
      );
    }
    entries.push({ status, path: filePath, additions: 0, deletions: 0 });
    index += 2;
  }
  return entries;
}

export function isGitBinaryPatch(patch: string): boolean {
  const trimmed = patch.trim();
  if (trimmed.length === 0) return false;
  return /^Binary files .+ differ$/m.test(trimmed.split("\n")[0] ?? "");
}

export function discoverRepositoryRulePaths(changedPaths: readonly string[]): readonly string[] {
  const discovered = new Set<string>(TRUSTED_REPOSITORY_RULE_PATHS);
  for (const changedPath of changedPaths) {
    let directory = path.posix.dirname(changedPath);
    while (true) {
      if (directory === "." || directory === "") {
        discovered.add("AGENTS.md");
        break;
      }
      discovered.add(`${directory}/AGENTS.md`);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...discovered].sort();
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

async function readGitBlobAtRevision(
  sourceDir: string,
  sha: string,
  rulePath: string,
  gitExecutable: string,
  gitRunner: GitRunner,
): Promise<string | undefined> {
  const result = await runGitCollect(
    gitExecutable,
    ["show", `${sha}:${rulePath}`],
    sourceDir,
    gitRunner,
  );
  if (result.exitCode !== 0) return undefined;
  const content = result.stdout;
  if (Buffer.byteLength(content, "utf8") > MAX_RULE_CONTENT_BYTES) {
    throw new Error(
      `[DEEP_REVIEW_PACKET_INCOMPLETE] repository rule ${rulePath} exceeds size limit`,
    );
  }
  return content;
}

export async function collectRepositoryRules(
  sourceDir: string,
  baseSha: string,
  headSha: string,
  gitExecutable: string,
  gitRunner: GitRunner,
  changedPaths: readonly string[] = [],
): Promise<PullRequestPacketV1["rules"]> {
  const rules: PullRequestPacketV1["rules"][number][] = [];
  for (const rulePath of discoverRepositoryRulePaths(changedPaths)) {
    const [headContent, baseContent] = await Promise.all([
      readGitBlobAtRevision(sourceDir, headSha, rulePath, gitExecutable, gitRunner),
      readGitBlobAtRevision(sourceDir, baseSha, rulePath, gitExecutable, gitRunner),
    ]);
    if (headContent !== undefined) {
      rules.push({ path: rulePath, content: headContent, source: "head" });
    } else if (baseContent !== undefined) {
      rules.push({ path: rulePath, content: baseContent, source: "base" });
    }
  }
  return rules;
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
    let stdoutOverflow = false;
    let stderrOverflow = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, MAX_GIT_COMMAND_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        stdoutOverflow = true;
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
        stderrOverflow = true;
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutOverflow || stderrOverflow) {
        reject(
          new Error(
            `[DEEP_REVIEW_PACKET_INCOMPLETE] git output exceeds ${MAX_GIT_OUTPUT_BYTES} byte limit`,
          ),
        );
        return;
      }
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
  const rules = await collectRepositoryRules(
    sourceDir,
    pullRequest.baseSha,
    pullRequest.headSha,
    gitExecutable,
    gitRunner,
    files.map((file) => file.path),
  );

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
    rules,
    previousFindings,
  };

  const packetDigest = computePacketDigest(packetWithoutDigest);
  const packet = parsePullRequestPacket({ ...packetWithoutDigest, packetDigest });
  validatePacketCompleteness(packet);

  const serialized = `${JSON.stringify(packet, null, 2)}\n`;
  await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });

  return { packet, outputPath };
}
