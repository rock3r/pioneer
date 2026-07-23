import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxPolicy } from "../sandbox/launcher.js";

export type ReviewNetworkMode = "full" | "public" | "none";
export type ReviewPlatform = "darwin" | "linux" | "win32";

export interface ReviewPathSpec {
  readonly sourceDir: string;
  readonly allowReadPaths?: readonly string[];
  readonly allowWritePaths?: readonly string[];
}

export interface ValidatedReviewPaths {
  readonly sourceDir: string;
  readonly allowReadPaths: readonly string[];
  readonly allowWritePaths: readonly string[];
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

export async function validateReviewPaths(spec: ReviewPathSpec): Promise<ValidatedReviewPaths> {
  const sourceDir = await canonicalGrant(spec.sourceDir);
  const allowReadPaths = await canonicalList(spec.allowReadPaths ?? []);
  const allowWritePaths = await canonicalList(spec.allowWritePaths ?? []);
  for (const writable of allowWritePaths) {
    if (
      overlaps(writable, sourceDir) ||
      allowReadPaths.some((readable) => overlaps(writable, readable))
    ) {
      throw new Error(`Writable review path overlaps a read-only grant: ${writable}`);
    }
  }
  return { sourceDir, allowReadPaths, allowWritePaths };
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
