import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxPolicy } from "../sandbox/launcher.js";

export type ReviewNetworkMode = "full" | "public" | "none";
export type ReviewPlatform = "darwin" | "linux" | "win32";

export interface ReviewPathSpec {
  readonly sourceDir: string;
  readonly allowReadPaths?: readonly string[];
  readonly allowWritePaths?: readonly string[];
  readonly reportPath?: string;
  readonly workLogPath?: string;
}

export interface ValidatedReviewPaths {
  readonly sourceDir: string;
  readonly allowReadPaths: readonly string[];
  readonly allowWritePaths: readonly string[];
  readonly reportPath?: string;
  readonly workLogPath?: string;
}

export interface ReviewSandboxConfigOptions extends ValidatedReviewPaths {
  readonly platform: ReviewPlatform;
  readonly scratchDir: string;
  readonly runtimeReadPaths: readonly string[];
  readonly network: ReviewNetworkMode;
  readonly parentProxyUrl?: string;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

async function canonicalGrant(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink()) throw new Error(`Review path grant is a symbolic link: ${absolute}`);
  if (!stats.isDirectory()) throw new Error(`Review path grant is not a directory: ${absolute}`);
  const canonical = await realpath(absolute);
  if (canonical === path.parse(canonical).root || canonical === os.homedir()) {
    throw new Error(`Refusing broad review path grant: ${canonical}`);
  }
  return canonical;
}

async function canonicalList(paths: readonly string[]): Promise<string[]> {
  const values: string[] = [];
  for (const candidate of paths) {
    const canonical = await canonicalGrant(candidate);
    if (!values.includes(canonical)) values.push(canonical);
  }
  return values;
}

async function canonicalControllerOutputPath(candidate: string, kind: string): Promise<string> {
  if (!path.isAbsolute(candidate))
    throw new Error(`Review ${kind} path is not absolute: ${candidate}`);
  const absolute = path.normalize(candidate);
  const parent = path.dirname(absolute);
  let parentStats: Awaited<ReturnType<typeof lstat>>;
  try {
    parentStats = await lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Review ${kind} parent does not exist: ${parent}`);
    }
    throw error;
  }
  if (parentStats.isSymbolicLink()) {
    throw new Error(`Review ${kind} parent is a symbolic link: ${parent}`);
  }
  if (!parentStats.isDirectory())
    throw new Error(`Review ${kind} parent is not a directory: ${parent}`);
  try {
    await access(parent, constants.W_OK);
  } catch {
    throw new Error(`Review ${kind} parent is not writable: ${parent}`);
  }
  const canonicalParent = await realpath(parent);
  const reportPath = path.join(canonicalParent, path.basename(absolute));
  try {
    await lstat(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reportPath;
    throw error;
  }
  throw new Error(`Review ${kind} target already exists: ${reportPath}`);
}

async function canonicalProspectiveControllerOutputPath(
  candidate: string,
  kind: string,
): Promise<string> {
  if (!path.isAbsolute(candidate))
    throw new Error(`Review ${kind} path is not absolute: ${candidate}`);
  const absolute = path.normalize(candidate);
  let existingAncestor = path.dirname(absolute);
  let ancestorStats: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    try {
      ancestorStats = await lstat(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  const canonicalAncestor = await realpath(existingAncestor);
  if (ancestorStats.isSymbolicLink()) ancestorStats = await lstat(canonicalAncestor);
  if (!ancestorStats.isDirectory()) {
    throw new Error(`Review ${kind} ancestor is not a directory: ${canonicalAncestor}`);
  }
  return path.resolve(canonicalAncestor, path.relative(existingAncestor, absolute));
}

async function validateReviewPathsInternal(
  spec: ReviewPathSpec,
  prospectiveWorkLog: boolean,
): Promise<ValidatedReviewPaths> {
  const sourceDir = await canonicalGrant(spec.sourceDir);
  const allowReadPaths = await canonicalList(spec.allowReadPaths ?? []);
  const allowWritePaths = await canonicalList(spec.allowWritePaths ?? []);
  const reportPath =
    spec.reportPath === undefined
      ? undefined
      : await canonicalControllerOutputPath(spec.reportPath, "report");
  const workLogPath =
    spec.workLogPath === undefined
      ? undefined
      : await (prospectiveWorkLog
          ? canonicalProspectiveControllerOutputPath(spec.workLogPath, "work log")
          : canonicalControllerOutputPath(spec.workLogPath, "work log"));
  for (const writable of allowWritePaths) {
    if (
      overlaps(writable, sourceDir) ||
      allowReadPaths.some((readable) => overlaps(writable, readable))
    ) {
      throw new Error(`Writable review path overlaps a read-only grant: ${writable}`);
    }
  }
  if (
    reportPath !== undefined &&
    [sourceDir, ...allowReadPaths, ...allowWritePaths].some((grant) => contains(grant, reportPath))
  ) {
    throw new Error(`Review report target is actor-visible: ${reportPath}`);
  }
  if (
    workLogPath !== undefined &&
    [sourceDir, ...allowReadPaths, ...allowWritePaths].some((grant) => contains(grant, workLogPath))
  ) {
    throw new Error(`Review work log target is actor-visible: ${workLogPath}`);
  }
  if (reportPath !== undefined && workLogPath === reportPath) {
    throw new Error(`Review report and work log targets are identical: ${reportPath}`);
  }
  return {
    sourceDir,
    allowReadPaths,
    allowWritePaths,
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(workLogPath === undefined ? {} : { workLogPath }),
  };
}

export async function validateProspectiveReviewWorkLogPath(
  spec: ReviewPathSpec & { readonly workLogPath: string },
): Promise<string> {
  const paths = await validateReviewPathsInternal(spec, true);
  if (paths.workLogPath === undefined) throw new Error("Review work log path was not validated");
  return paths.workLogPath;
}

export async function validateReviewPaths(spec: ReviewPathSpec): Promise<ValidatedReviewPaths> {
  return await validateReviewPathsInternal(spec, false);
}

export function buildReviewSandboxConfig(options: ReviewSandboxConfigOptions): SandboxPolicy {
  if (options.platform === "win32") {
    throw new Error("Review filesystem isolation is unavailable on Windows");
  }
  if (options.network !== "none" && options.parentProxyUrl === undefined) {
    throw new Error("Review networking requires an authenticated parent proxy");
  }
  return {
    readOnlyPaths: [options.sourceDir, ...options.allowReadPaths, ...options.runtimeReadPaths],
    writablePaths: [options.scratchDir, ...options.allowWritePaths],
    network: options.network === "none" ? "none" : "proxy",
    ...(options.parentProxyUrl === undefined ? {} : { proxyUrl: options.parentProxyUrl }),
  };
}
