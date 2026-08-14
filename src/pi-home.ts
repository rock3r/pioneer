import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PiHomeMode = "review" | "eval";

export interface PreparePiHomeOptions {
  readonly destination: string;
  readonly mode: PiHomeMode;
  readonly sourceDir?: string;
  readonly piHomeIncludes?: readonly string[];
}

export interface PreparedPiHome {
  readonly root: string;
  readonly agentDir: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly sourceDir: string;
  readonly environment: Readonly<Record<string, string>>;
}

const MAX_ENTRIES = 500_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_ROOT_FILES = [
  "auth.json",
  "models.json",
  "models-store.json",
  "settings.json",
  "AGENTS.md",
] as const;
const HARD_EXCLUDED_NAMES = new Set(["sessions", "logs", ".npm", ".cache", "tmp", ".tmp", "temp"]);
const DEFAULT_SKIPPED_NAMES = new Set(["node_modules", ".git", "npm", "git"]);

interface SelectedEntry {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly stats: Awaited<ReturnType<typeof lstat>>;
}

interface SelectionState {
  readonly entries: Map<string, SelectedEntry>;
  readonly budget: SnapshotBudget;
}

interface SnapshotBudget {
  entries: number;
  bytes: number;
}

function relativePath(parts: readonly string[]): string {
  return parts.join("/");
}

function isLogFile(name: string): boolean {
  return name.endsWith(".log") || name.endsWith("-debug.log");
}

function isHardExcluded(parts: readonly string[]): boolean {
  return parts.some((part) => HARD_EXCLUDED_NAMES.has(part) || isLogFile(part));
}

function isDefaultSkipped(parts: readonly string[]): boolean {
  const name = parts.at(-1);
  return name !== undefined && (DEFAULT_SKIPPED_NAMES.has(name) || isHardExcluded(parts));
}

function formatInclude(include: string): string {
  return JSON.stringify(include);
}

function invalidInclude(include: string, reason: string): Error {
  return new Error(`[PI_HOME_INCLUDE_INVALID] Pi home include ${formatInclude(include)} ${reason}`);
}

function ensureInside(sourceRoot: string, candidate: string, include: string): string {
  const relative = path.relative(sourceRoot, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw invalidInclude(include, "escapes the selected Pi home");
  }
  return relative.split(path.sep).join("/");
}

function normalizeInclude(include: string): string[] {
  if (include.length === 0) throw invalidInclude(include, "must not be empty");
  if (include.includes("\0")) throw invalidInclude(include, "must not contain NUL");
  if (path.isAbsolute(include) || path.win32.isAbsolute(include)) {
    throw invalidInclude(include, "must be relative to the selected Pi home");
  }
  if (/[?*[\]{}]/u.test(include)) throw invalidInclude(include, "must name one exact path");
  const parts = include.split(/[\\/]/u);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw invalidInclude(include, "must not contain empty, . or .. path segments");
  }
  return parts;
}

function assertNotHardExcluded(parts: readonly string[], include: string): void {
  if (isHardExcluded(parts)) throw invalidInclude(include, "is a hard-excluded runtime path");
}

function symlinkTargetRelative(
  sourceRoot: string,
  relativePathValue: string,
  target: string,
): string {
  const relativeTarget = path.relative(sourceRoot, target);
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(
      `[PI_HOME_SYMLINK_ESCAPING] Pi home contains an escaping symbolic link at ${relativePathValue}`,
    );
  }
  return relativeTarget.split(path.sep).join("/");
}

async function selectedEntry(
  sourceRoot: string,
  relative: string,
  state: SelectionState,
): Promise<SelectedEntry> {
  const existing = state.entries.get(relative);
  if (existing !== undefined) return existing;
  const source = path.join(sourceRoot, ...relative.split("/"));
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`[PI_HOME_SNAPSHOT_MISSING] Pi home path is missing: ${relative}`);
    }
    throw error;
  }
  const kind = stats.isDirectory()
    ? "directory"
    : stats.isFile()
      ? "file"
      : stats.isSymbolicLink()
        ? "symlink"
        : undefined;
  if (kind === undefined) {
    throw new Error(`[PI_HOME_SPECIAL_FILE] Pi home contains a special file at ${relative}`);
  }
  const entry: SelectedEntry = { relativePath: relative, sourcePath: source, kind, stats };
  state.entries.set(relative, entry);
  state.budget.entries += 1;
  if (state.budget.entries > MAX_ENTRIES) throw new Error("Pi home exceeds the entry limit");
  if (kind === "file") {
    state.budget.bytes += Number(stats.size);
    if (state.budget.bytes > MAX_BYTES) throw new Error("Pi home exceeds the size limit");
  }
  return entry;
}

async function collectEntry(
  sourceRoot: string,
  relative: string,
  state: SelectionState,
  traversal: "default" | "explicit" | "scaffold",
): Promise<void> {
  const entry = await selectedEntry(sourceRoot, relative, state);
  if (entry.kind === "directory") {
    if (traversal === "scaffold") return;
    const children = (await readdir(entry.sourcePath, { withFileTypes: true }))
      .map((child) => child.name)
      .sort();
    for (const name of children) {
      const childRelative = `${relative}/${name}`;
      const childParts = childRelative.split("/");
      if (traversal === "default" && isDefaultSkipped(childParts)) continue;
      if (traversal !== "default" && isHardExcluded(childParts)) continue;
      await collectEntry(sourceRoot, childRelative, state, traversal);
    }
    return;
  }
  if (entry.kind === "symlink") {
    let target: string;
    try {
      target = await realpath(entry.sourcePath);
    } catch {
      throw new Error(
        `[PI_HOME_SYMLINK_BROKEN] Pi home contains a broken symbolic link at ${relative}`,
      );
    }
    const targetRelative = symlinkTargetRelative(sourceRoot, relative, target);
    const targetStats = await lstat(target);
    if (!targetStats.isFile() && !targetStats.isDirectory()) {
      throw new Error(`[PI_HOME_SPECIAL_FILE] Pi home symlink target is special at ${relative}`);
    }
    void targetRelative;
  }
}

async function validateExplicitInclude(
  sourceRoot: string,
  include: string,
  state: SelectionState,
): Promise<void> {
  const parts = normalizeInclude(include);
  assertNotHardExcluded(parts, include);
  const candidate = path.join(sourceRoot, ...parts);
  let lexicalStats: Awaited<ReturnType<typeof lstat>>;
  try {
    lexicalStats = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw invalidInclude(include, "does not exist");
    }
    throw error;
  }
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    if (lexicalStats.isSymbolicLink()) {
      throw new Error(
        `[PI_HOME_SYMLINK_BROKEN] Pi home include ${formatInclude(include)} is a broken symbolic link`,
      );
    }
    throw invalidInclude(include, "could not be canonicalized");
  }
  let relativeCanonical: string;
  try {
    relativeCanonical = ensureInside(sourceRoot, canonicalCandidate, include);
  } catch (error) {
    if (lexicalStats.isSymbolicLink()) {
      throw new Error(
        `[PI_HOME_SYMLINK_ESCAPING] Pi home include ${formatInclude(include)} is an escaping symbolic link`,
      );
    }
    throw error;
  }
  assertNotHardExcluded(relativeCanonical.split("/"), include);
  for (let index = 1; index < parts.length; index += 1) {
    await collectEntry(sourceRoot, relativePath(parts.slice(0, index)), state, "scaffold");
  }
  const entry = await selectedEntry(sourceRoot, relativePath(parts), state);
  if (entry.kind === "symlink") {
    const targetStats = await lstat(canonicalCandidate);
    if (!targetStats.isFile() && !targetStats.isDirectory()) {
      throw new Error(
        `[PI_HOME_SPECIAL_FILE] Pi home include ${formatInclude(include)} targets a special file`,
      );
    }
  }
  await collectEntry(sourceRoot, relativePath(parts), state, "explicit");
  void relativeCanonical;
}

async function validateSelectedSymlinks(sourceRoot: string, state: SelectionState): Promise<void> {
  for (const entry of state.entries.values()) {
    if (entry.kind !== "symlink") continue;
    const target = await realpath(entry.sourcePath).catch(() => undefined);
    if (target === undefined) {
      throw new Error(
        `[PI_HOME_SYMLINK_BROKEN] Pi home contains a broken symbolic link at ${entry.relativePath}`,
      );
    }
    const targetRelative = symlinkTargetRelative(sourceRoot, entry.relativePath, target);
    if (!state.entries.has(targetRelative)) {
      if (isHardExcluded(targetRelative.split("/"))) {
        throw new Error(
          `[PI_HOME_SYMLINK_TARGET_EXCLUDED] Selected Pi home symlink ${entry.relativePath} targets hard-excluded path ${targetRelative}`,
        );
      }
      throw new Error(
        `[PI_HOME_SYMLINK_TARGET_MISSING] Selected Pi home symlink ${entry.relativePath} targets ${targetRelative}, which is not selected. Add --pi-home-include ${targetRelative}.`,
      );
    }
  }
  for (const entry of state.entries.values()) {
    const parts = entry.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = state.entries.get(relativePath(parts.slice(0, index)));
      if (parent?.kind === "symlink") {
        throw new Error(
          `[PI_HOME_DESTINATION_COLLISION] Selected Pi home paths ${parent.relativePath} and ${entry.relativePath} would collide through an internal symlink`,
        );
      }
    }
  }
}

async function collectDefaultFile(
  sourceRoot: string,
  relative: string,
  state: SelectionState,
): Promise<void> {
  const entry = await selectedEntry(sourceRoot, relative, state);
  if (entry.kind === "directory") {
    throw new Error(`[PI_HOME_SPECIAL_FILE] Pi home default path is not a file: ${relative}`);
  }
  if (entry.kind === "symlink") {
    const target = await realpath(entry.sourcePath).catch(() => undefined);
    if (target === undefined || !(await lstat(target)).isFile()) {
      throw new Error(`[PI_HOME_SPECIAL_FILE] Pi home default path is not a file: ${relative}`);
    }
  }
  await collectEntry(sourceRoot, relative, state, "default");
}

async function buildSelection(
  sourceRoot: string,
  mode: PiHomeMode,
  includes: readonly string[],
): Promise<SelectionState> {
  if (mode === "eval" && includes.length > 0) {
    throw new Error(
      "[PI_HOME_INCLUDE_UNSUPPORTED] Pi home includes are supported only for review snapshots",
    );
  }
  const state: SelectionState = {
    entries: new Map(),
    budget: { entries: 0, bytes: 0 },
  };
  for (const name of DEFAULT_ROOT_FILES) {
    try {
      await collectDefaultFile(sourceRoot, name, state);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[PI_HOME_SNAPSHOT_MISSING]"))
        continue;
      throw error;
    }
  }
  if (mode === "review") {
    try {
      await collectEntry(sourceRoot, "skills", state, "default");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("[PI_HOME_SNAPSHOT_MISSING]"))
        throw error;
    }
  }
  for (const include of includes) await validateExplicitInclude(sourceRoot, include, state);
  await validateSelectedSymlinks(sourceRoot, state);
  return state;
}

async function copySelection(
  sourceRoot: string,
  state: SelectionState,
  destinationRoot: string,
): Promise<void> {
  const entries = [...state.entries.values()].sort((left, right) => {
    const depthDifference =
      left.relativePath.split("/").length - right.relativePath.split("/").length;
    return depthDifference || left.relativePath.localeCompare(right.relativePath);
  });
  for (const entry of entries) {
    const destination = path.join(destinationRoot, ...entry.relativePath.split("/"));
    if (entry.kind === "directory") {
      await mkdir(destination, { mode: 0o700, recursive: true });
    } else if (entry.kind === "file") {
      await copyFile(
        entry.sourcePath,
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      await chmod(destination, Number(entry.stats.mode) & 0o777);
    } else {
      const target = await realpath(entry.sourcePath);
      const targetRelative = symlinkTargetRelative(sourceRoot, entry.relativePath, target);
      const targetDestination = path.join(destinationRoot, ...targetRelative.split("/"));
      await symlink(path.relative(path.dirname(destination), targetDestination), destination);
    }
  }
}

export function defaultPiAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PI_CODING_AGENT_DIR;
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".pi", "agent");
}

async function assertMissing(candidate: string): Promise<void> {
  try {
    await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Isolated Pi home destination already exists: ${candidate}`);
}

export async function prepareIsolatedPiHome(
  options: PreparePiHomeOptions,
): Promise<PreparedPiHome> {
  const sourceDir = await realpath(options.sourceDir ?? defaultPiAgentDir());
  const sourceStats = await lstat(sourceDir);
  if (!sourceStats.isDirectory())
    throw new Error(`Pi home source is not a directory: ${sourceDir}`);
  const selection = await buildSelection(sourceDir, options.mode, options.piHomeIncludes ?? []);
  const requestedRoot = path.resolve(options.destination);
  await assertMissing(requestedRoot);
  await mkdir(path.dirname(requestedRoot), { recursive: true });
  await mkdir(requestedRoot, { mode: 0o700 });
  const root = await realpath(requestedRoot);
  const agentDir = path.join(root, "agent");
  const homeDir = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  await mkdir(agentDir, { mode: 0o700 });
  await copySelection(sourceDir, selection, agentDir);
  await mkdir(homeDir, { mode: 0o700 });
  await mkdir(tmpDir, { mode: 0o700 });
  await access(agentDir, constants.R_OK | constants.W_OK);
  return {
    root,
    agentDir,
    homeDir,
    tmpDir,
    sourceDir,
    environment: { HOME: homeDir, TMPDIR: tmpDir, PI_CODING_AGENT_DIR: agentDir },
  };
}
