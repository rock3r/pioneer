import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ReviewNetworkMode } from "./isolation.js";

export interface ImmutableReviewScope {
  readonly sourceDir: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly piHomeSource?: string;
  readonly piHomeIncludes?: readonly string[];
  readonly allowReadPaths?: readonly string[];
  readonly allowWritePaths?: readonly string[];
  readonly network: ReviewNetworkMode;
  readonly piVersion: string;
}

export interface ReviewResumeArchive {
  readonly token: string;
  readonly archiveDir: string;
  readonly attemptsDir: string;
  readonly activeAttemptDir: string;
  readonly leaseContents?: string;
}

export interface LoadedReviewResumeArchive {
  readonly archive: ReviewResumeArchive;
  readonly scope: ImmutableReviewScope;
  readonly state: string;
}

export const MAX_RESUME_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_RESUME_ARCHIVE_FILES = 10_000;
export const MAX_RESUME_MANIFEST_BYTES = 1 * 1024 * 1024;
export const MAX_RETAINED_RESUME_ARCHIVES = 10;
export const RESUME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RESUME_ATTEMPT = 9_999;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function appDataRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  const pathApi = platformPath(platform);
  const ensureAbsolute = (root: string): string => {
    if (!pathApi.isAbsolute(root)) throw new Error("Review application-data root must be absolute");
    return root;
  };
  if (platform === "darwin") {
    return ensureAbsolute(pathApi.join(home, "Library", "Application Support", "Pioneer"));
  }
  if (platform === "win32") {
    const base = environment.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local");
    return ensureAbsolute(pathApi.join(base, "Pioneer"));
  }
  const base = environment.XDG_DATA_HOME ?? pathApi.join(home, ".local", "share");
  return ensureAbsolute(pathApi.join(base, "pioneer"));
}

export function defaultReviewResumeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  return platformPath(platform).join(appDataRoot(environment, platform, home), "review-resumes");
}

export function defaultReviewReportDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  return platformPath(platform).join(appDataRoot(environment, platform, home), "reports");
}

export function isResumeToken(token: string): boolean {
  return UUID.test(token);
}

export function resumeArchivePath(root: string, token: string): string {
  if (!isResumeToken(token)) throw new Error("Review resume token must be a UUID");
  return path.join(root, token);
}

export function immutableReviewScope(
  scope: ImmutableReviewScope,
): Readonly<Record<string, unknown>> {
  return {
    sourceDir: scope.sourceDir,
    promptSha256: createHash("sha256").update(scope.prompt).digest("hex"),
    model: scope.model,
    thinking: scope.thinking,
    piHomeSource: scope.piHomeSource,
    piHomeIncludes: scope.piHomeIncludes,
    allowReadPaths: scope.allowReadPaths,
    allowWritePaths: scope.allowWritePaths,
    network: scope.network,
    piVersion: scope.piVersion,
  };
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink())
    throw new Error(`Review resume directory is a symbolic link: ${directory}`);
  if (!stats.isDirectory()) throw new Error(`Review resume path is not a directory: ${directory}`);
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function canonicalPathForContainment(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(candidate);
    throw error;
  }
}

async function canonicalResumeRoot(
  root: string,
  actorVisiblePaths: readonly string[],
  create: boolean,
): Promise<string> {
  if (!path.isAbsolute(root)) throw new Error("Review resume root must be an absolute path");
  if (create) {
    await privateDirectory(root);
  } else {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume root is invalid");
    }
  }
  const canonicalRoot = await realpath(root);
  for (const grant of actorVisiblePaths) {
    const canonicalGrant = await canonicalPathForContainment(grant);
    if (overlaps(canonicalRoot, canonicalGrant)) {
      throw new Error(`Review resume root overlaps an actor-visible grant: ${canonicalGrant}`);
    }
  }
  return canonicalRoot;
}

function overlaps(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return (
    relativeLeft === "" ||
    relativeRight === "" ||
    (!relativeLeft.startsWith("..") && !path.isAbsolute(relativeLeft)) ||
    (!relativeRight.startsWith("..") && !path.isAbsolute(relativeRight))
  );
}

function validAttemptNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_RESUME_ATTEMPT
    ? value
    : undefined;
}

async function writeAtomicJsonFile(
  target: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readManifest(directory: string): Promise<Record<string, unknown> | undefined> {
  try {
    const manifestPath = path.join(directory, "manifest.json");
    const stats = await lstat(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_RESUME_MANIFEST_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function activeLeaseIsHeld(directory: string): Promise<boolean> {
  try {
    const leasePath = path.join(directory, "lease");
    const stats = await lstat(leasePath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    const value: unknown = JSON.parse(await readFile(leasePath, "utf8"));
    if (typeof value !== "object" || value === null) return false;
    const pid = (value as Record<string, unknown>).pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
    try {
      process.kill(pid as number, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

export async function reviewResumeArchiveHasLiveLease(
  archive: ReviewResumeArchive,
): Promise<boolean> {
  return await activeLeaseIsHeld(archive.archiveDir);
}

async function acquireReviewResumeArchiveLease(archive: ReviewResumeArchive): Promise<string> {
  const leasePath = path.join(archive.archiveDir, "lease");
  const leaseContents = `${JSON.stringify({
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(leasePath, leaseContents, { flag: "wx", mode: 0o600 });
      return leaseContents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await activeLeaseIsHeld(archive.archiveDir)) {
        throw new Error("[REVIEW_RESUME_IN_USE] Review resume archive is still active");
      }
      const observedLease = await readFile(leasePath, "utf8").catch(() => undefined);
      if (observedLease === undefined) continue;
      const staleLeasePath = `${leasePath}.stale-${randomUUID()}`;
      try {
        const currentLease = await readFile(leasePath, "utf8").catch(() => undefined);
        if (currentLease !== observedLease) continue;
        await rename(leasePath, staleLeasePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      try {
        const movedLease = await readFile(staleLeasePath, "utf8").catch(() => undefined);
        if (movedLease !== observedLease) {
          await rename(staleLeasePath, leasePath).catch((restoreError: unknown) => {
            if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
          });
          continue;
        }
        await writeFile(leasePath, leaseContents, { flag: "wx", mode: 0o600 });
        return leaseContents;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      } finally {
        await rm(staleLeasePath, { force: true });
      }
    }
  }
  throw new Error("[REVIEW_RESUME_IN_USE] Review resume archive lease could not be acquired");
}

async function releaseReviewResumeArchiveLease(
  archive: ReviewResumeArchive,
  expectedContents: string | undefined,
): Promise<void> {
  if (expectedContents === undefined) return;
  const leasePath = path.join(archive.archiveDir, "lease");
  const currentContents = await readFile(leasePath, "utf8").catch(() => undefined);
  if (currentContents !== expectedContents) return;
  await unlink(leasePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function archiveTimestamp(manifest: Record<string, unknown>): Promise<number> {
  const value = manifest.retainedAt ?? manifest.createdAt;
  if (typeof value !== "string") return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function pruneReviewResumeArchiveTemporaryEntries(
  archiveDir: string,
  now: number,
): Promise<void> {
  const candidates: string[] = [];
  for (const entry of await readdir(archiveDir, { withFileTypes: true })) {
    if (entry.name.startsWith("manifest.json.tmp-") || entry.name.startsWith("lease.stale-")) {
      candidates.push(path.join(archiveDir, entry.name));
    }
  }
  const attemptsDir = path.join(archiveDir, "attempts");
  for (const entry of await readdir(attemptsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".attempt-")) candidates.push(path.join(attemptsDir, entry.name));
  }
  for (const candidate of candidates) {
    const stats = await lstat(candidate).catch(() => undefined);
    if (stats !== undefined && now - stats.mtimeMs >= RESUME_RETENTION_MS) {
      await rm(candidate, { recursive: true, force: true });
    }
  }
}

export async function pruneReviewResumeArchives(root: string, now = Date.now()): Promise<void> {
  await privateDirectory(root);
  const candidates = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && UUID.test(entry.name),
  );
  const inactive: Array<{ directory: string; timestamp: number }> = [];
  for (const candidate of candidates) {
    const directory = path.join(root, candidate.name);
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) continue;
    await pruneReviewResumeArchiveTemporaryEntries(directory, now);
    const manifest = await readManifest(directory);
    if (manifest === undefined) {
      if (await activeLeaseIsHeld(directory)) continue;
      if (now - stats.mtimeMs >= RESUME_RETENTION_MS) {
        await rm(directory, { recursive: true, force: true });
      }
      continue;
    }
    const timestamp = await archiveTimestamp(manifest);
    const expired = timestamp === 0 || now - timestamp >= RESUME_RETENTION_MS;
    if (await activeLeaseIsHeld(directory)) continue;
    if (expired) {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    inactive.push({ directory, timestamp });
  }
  inactive.sort((left, right) => right.timestamp - left.timestamp);
  for (const candidate of inactive.slice(MAX_RETAINED_RESUME_ARCHIVES)) {
    await rm(candidate.directory, { recursive: true, force: true });
  }
}

export async function createReviewResumeArchive(
  root: string,
  scope: ImmutableReviewScope,
  token = randomUUID(),
  actorVisiblePaths: readonly string[] = [],
): Promise<ReviewResumeArchive> {
  if (!isResumeToken(token)) throw new Error("Review resume token must be a UUID");
  const canonicalRoot = await canonicalResumeRoot(root, actorVisiblePaths, true);
  await pruneReviewResumeArchives(canonicalRoot);
  const archiveDir = resumeArchivePath(canonicalRoot, token);
  let archiveCreated = false;
  try {
    await mkdir(archiveDir, { mode: 0o700 });
    archiveCreated = true;
    await privateDirectory(archiveDir);
    const attemptsDir = path.join(archiveDir, "attempts");
    await privateDirectory(attemptsDir);
    const activeAttemptDir = path.join(attemptsDir, "0001");
    await privateDirectory(activeAttemptDir);
    const manifest = {
      schemaVersion: 1,
      token,
      scope: immutableReviewScope(scope),
      promptSha256: createHash("sha256").update(scope.prompt).digest("hex"),
      createdAt: new Date().toISOString(),
      piVersion: scope.piVersion,
      attempt: 1,
      state: "active",
    };
    await writeAtomicJsonFile(path.join(archiveDir, "manifest.json"), manifest);
    const leaseContents = `${JSON.stringify({
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`;
    await writeFile(path.join(archiveDir, "lease"), leaseContents, { flag: "wx", mode: 0o600 });
    return {
      token,
      archiveDir: await realpath(archiveDir),
      attemptsDir: await realpath(attemptsDir),
      activeAttemptDir: await realpath(activeAttemptDir),
      leaseContents,
    };
  } catch (error) {
    if (archiveCreated) await rm(archiveDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function prepareDefaultReviewReportPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): Promise<string> {
  await privateDirectory(appDataRoot(environment, platform, home));
  const directory = defaultReviewReportDirectory(environment, platform, home);
  await privateDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const reports = entries
    .filter((entry) => entry.isFile() && /^review-[0-9a-fzt-]+\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of reports.slice(0, Math.max(0, reports.length - 99))) {
    await unlink(path.join(directory, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return path.join(
    directory,
    `review-${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID()}.md`,
  );
}

export async function inspectReviewResumeSessionTree(
  root: string,
  maxEntries = MAX_RESUME_ARCHIVE_FILES,
): Promise<{ sizeBytes: number; fileCount: number; entryCount: number }> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Review resume session candidate is not a regular directory: ${root}`);
  }
  let sizeBytes = 0;
  let fileCount = 0;
  let entryCount = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new Error(`Review resume session candidate contains an unsafe entry: ${candidate}`);
      }
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error("Review resume session archive exceeds its bounded retention limit");
      }
      if (stats.isDirectory()) {
        await visit(candidate);
      } else {
        fileCount += 1;
        sizeBytes += stats.size;
        if (sizeBytes > MAX_RESUME_ARCHIVE_BYTES) {
          throw new Error("Review resume session archive exceeds its bounded retention limit");
        }
      }
    }
  };
  await visit(root);
  return { sizeBytes, fileCount, entryCount };
}

export async function inspectReviewResumeArchive(
  archive: ReviewResumeArchive,
  committedOnly = false,
): Promise<{
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly entryCount: number;
}> {
  return await inspectReviewResumeArchiveInternal(archive, committedOnly);
}

async function inspectReviewResumeArchiveInternal(
  archive: ReviewResumeArchive,
  committedOnly: boolean,
): Promise<{
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly entryCount: number;
}> {
  const attempts = (await readdir(archive.attemptsDir, { withFileTypes: true })).filter(
    (entry) =>
      entry.isDirectory() &&
      /^\d{4}$/.test(entry.name) &&
      (!committedOnly || entry.name === path.basename(archive.activeAttemptDir)),
  );
  let sizeBytes = 0;
  let fileCount = 0;
  let entryCount = 0;
  for (const attempt of attempts) {
    const usage = await inspectReviewResumeSessionTree(
      path.join(archive.attemptsDir, attempt.name),
    );
    sizeBytes += usage.sizeBytes;
    fileCount += usage.fileCount;
    entryCount += usage.entryCount;
    if (sizeBytes > MAX_RESUME_ARCHIVE_BYTES || entryCount > MAX_RESUME_ARCHIVE_FILES) {
      throw new Error("Review resume session archive exceeds its bounded retention limit");
    }
  }
  return { sizeBytes, fileCount, entryCount };
}

export async function findReviewResumeSessionFile(attemptDir: string): Promise<string> {
  await inspectReviewResumeSessionTree(attemptDir);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
    }
  };
  await visit(attemptDir);
  if (files.length !== 1) {
    throw new Error(
      "Review resume session candidate does not contain exactly one native session file",
    );
  }
  return await realpath(files[0] as string);
}

export async function retainReviewResumeArchive(
  archive: ReviewResumeArchive,
  failureCode: string,
): Promise<{ sizeBytes: number; fileCount: number; entryCount: number }> {
  const leaseContents = archive.leaseContents ?? (await acquireReviewResumeArchiveLease(archive));
  try {
    if (archive.leaseContents !== undefined) {
      const currentContents = await readFile(path.join(archive.archiveDir, "lease"), "utf8").catch(
        () => undefined,
      );
      if (currentContents !== archive.leaseContents) {
        throw new Error("[REVIEW_RESUME_IN_USE] Review resume archive lease ownership changed");
      }
    }
    const usage = await inspectReviewResumeSessionTree(archive.activeAttemptDir);
    if (usage.fileCount === 0) throw new Error("Review resume session candidate is empty");
    const archiveUsage = await inspectReviewResumeArchive(archive);
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = await readManifest(archive.archiveDir);
    if (manifest === undefined) {
      throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is invalid");
    }
    await writeAtomicJsonFile(manifestPath, {
      ...manifest,
      state: failureCode === "REVIEW_REPORT_WRITE_FAILED" ? "report_delivery_failed" : "retained",
      failureCode,
      retainedAt: new Date().toISOString(),
    });
    await pruneReviewResumeArchives(path.dirname(archive.archiveDir));
    return archiveUsage;
  } finally {
    await releaseReviewResumeArchiveLease(archive, leaseContents);
  }
}

export async function deleteReviewResumeArchive(archive: ReviewResumeArchive): Promise<void> {
  await rm(archive.archiveDir, { recursive: true, force: true });
}

export async function copyReviewResumeSession(
  archive: ReviewResumeArchive,
  sourceAttemptDir: string,
  attemptNumber: number,
): Promise<ReviewResumeArchive> {
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > MAX_RESUME_ATTEMPT
  ) {
    throw new Error(
      `[REVIEW_RESUME_ATTEMPT_LIMIT] Review resume attempt must be between 1 and ${MAX_RESUME_ATTEMPT}`,
    );
  }
  await inspectReviewResumeSessionTree(sourceAttemptDir);
  const destination = path.join(archive.attemptsDir, String(attemptNumber).padStart(4, "0"));
  const staging = path.join(archive.attemptsDir, `.attempt-${randomUUID()}`);
  const leaseContents = await acquireReviewResumeArchiveLease(archive);
  let promoted = false;
  let ownershipTransferred = false;
  try {
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = await readManifest(archive.archiveDir);
    if (manifest === undefined) {
      throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is invalid");
    }
    const committedAttemptNumber = validAttemptNumber(manifest.attempt);
    if (committedAttemptNumber === undefined) {
      throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest attempt is invalid");
    }
    if (attemptNumber === committedAttemptNumber) {
      throw new Error("[REVIEW_RESUME_ATTEMPT_INVALID] Review resume attempt is already committed");
    }
    const committedAttempt = String(committedAttemptNumber).padStart(4, "0");
    for (const entry of await readdir(archive.attemptsDir, { withFileTypes: true })) {
      if (/^\d{4}$/.test(entry.name) && entry.name !== committedAttempt) {
        await rm(path.join(archive.attemptsDir, entry.name), { recursive: true, force: true });
      }
    }
    await privateDirectory(staging);
    await cp(sourceAttemptDir, staging, {
      recursive: true,
      force: false,
      verbatimSymlinks: true,
    });
    await inspectReviewResumeSessionTree(staging);
    await rename(staging, destination);
    promoted = true;
    const next = {
      ...archive,
      activeAttemptDir: await realpath(destination),
      leaseContents,
    };
    await inspectReviewResumeArchive(next);
    await writeAtomicJsonFile(manifestPath, {
      ...manifest,
      state: "active",
      attempt: attemptNumber,
    });
    ownershipTransferred = true;
    return next;
  } catch (error) {
    if (!promoted) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (promoted) await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (!ownershipTransferred) {
      await releaseReviewResumeArchiveLease(archive, leaseContents);
    }
  }
}

export async function loadReviewResumeArchive(
  root: string,
  token: string,
): Promise<LoadedReviewResumeArchive> {
  if (!isResumeToken(token))
    throw new Error("[REVIEW_RESUME_INVALID_TOKEN] Review resume token is invalid");
  const canonicalRoot = await canonicalResumeRoot(root, [], false);
  const archiveDir = resumeArchivePath(canonicalRoot, token);
  const archiveStats = await lstat(archiveDir).catch(() => undefined);
  if (archiveStats === undefined || archiveStats.isSymbolicLink() || !archiveStats.isDirectory()) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume archive is unavailable");
  }
  const manifestPath = path.join(archiveDir, "manifest.json");
  const manifestStats = await lstat(manifestPath).catch(() => undefined);
  if (manifestStats === undefined) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is unavailable");
  }
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is unavailable");
  }
  if (manifestStats.size > MAX_RESUME_MANIFEST_BYTES) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest exceeds its bounded limit");
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is invalid");
  }
  if (
    manifest.token !== token ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.scope !== "object" ||
    manifest.scope === null
  ) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is invalid");
  }
  const lifecycleTimestamp = manifest.retainedAt ?? manifest.createdAt;
  if (typeof lifecycleTimestamp !== "string") {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume lifecycle timestamp is invalid");
  }
  const lifecycleTime = Date.parse(lifecycleTimestamp);
  if (!Number.isFinite(lifecycleTime) || Date.now() - lifecycleTime >= RESUME_RETENTION_MS) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume archive has expired");
  }
  const rawScope = manifest.scope as Record<string, unknown>;
  if (
    typeof rawScope.sourceDir !== "string" ||
    typeof rawScope.promptSha256 !== "string" ||
    typeof rawScope.network !== "string" ||
    typeof rawScope.piVersion !== "string"
  ) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume scope is invalid");
  }
  await canonicalResumeRoot(
    root,
    [
      rawScope.sourceDir,
      ...(Array.isArray(rawScope.allowReadPaths)
        ? rawScope.allowReadPaths.filter((value): value is string => typeof value === "string")
        : []),
      ...(Array.isArray(rawScope.allowWritePaths)
        ? rawScope.allowWritePaths.filter((value): value is string => typeof value === "string")
        : []),
    ],
    false,
  );
  const committedAttemptNumber = validAttemptNumber(manifest.attempt);
  if (committedAttemptNumber === undefined) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume manifest attempt is invalid");
  }
  const attemptsDir = path.join(archiveDir, "attempts");
  const attemptsStats = await lstat(attemptsDir).catch(() => undefined);
  if (attemptsStats === undefined) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume attempts directory is invalid");
  }
  if (attemptsStats.isSymbolicLink() || !attemptsStats.isDirectory()) {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume attempts directory is invalid");
  }
  const committedAttempt = String(committedAttemptNumber).padStart(4, "0");
  const latest = (await readdir(attemptsDir, { withFileTypes: true })).find(
    (entry) => entry.isDirectory() && entry.name === committedAttempt,
  );
  if (latest === undefined)
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume has no session attempt");
  const activeAttemptDir = path.join(attemptsDir, latest.name);
  const activeStats = await lstat(activeAttemptDir).catch(() => undefined);
  if (activeStats === undefined) {
    throw new Error("[REVIEW_RESUME_SESSION_INVALID] Review resume session tree is invalid");
  }
  if (activeStats.isSymbolicLink() || !activeStats.isDirectory()) {
    throw new Error("[REVIEW_RESUME_SESSION_INVALID] Review resume session tree is invalid");
  }
  const archive: ReviewResumeArchive = {
    token,
    archiveDir: await realpath(archiveDir),
    attemptsDir: await realpath(attemptsDir),
    activeAttemptDir: await realpath(activeAttemptDir),
  };
  try {
    await inspectReviewResumeArchive(archive, true);
  } catch {
    throw new Error("[REVIEW_RESUME_SESSION_INVALID] Review resume session archive is invalid");
  }
  if (rawScope.network !== "full" && rawScope.network !== "public" && rawScope.network !== "none") {
    throw new Error("[REVIEW_RESUME_UNAVAILABLE] Review resume network policy is invalid");
  }
  const scope: ImmutableReviewScope = {
    sourceDir: rawScope.sourceDir,
    prompt: "",
    ...(typeof rawScope.model === "string" ? { model: rawScope.model } : {}),
    ...(typeof rawScope.thinking === "string" ? { thinking: rawScope.thinking } : {}),
    ...(typeof rawScope.piHomeSource === "string" ? { piHomeSource: rawScope.piHomeSource } : {}),
    ...(Array.isArray(rawScope.piHomeIncludes)
      ? {
          piHomeIncludes: rawScope.piHomeIncludes.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(Array.isArray(rawScope.allowReadPaths)
      ? {
          allowReadPaths: rawScope.allowReadPaths.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(Array.isArray(rawScope.allowWritePaths)
      ? {
          allowWritePaths: rawScope.allowWritePaths.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    network: rawScope.network as ReviewNetworkMode,
    piVersion: rawScope.piVersion,
  };
  return {
    archive,
    scope,
    state: typeof manifest.state === "string" ? manifest.state : "unknown",
  };
}
