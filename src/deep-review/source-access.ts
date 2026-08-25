import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export function canonicalSourcePath(sourceRoot: string, relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new Error("Path escapes source root");
  }
  const absolute = path.join(sourceRoot, normalized);
  const resolved = path.resolve(absolute);
  const rootResolved = path.resolve(sourceRoot);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error("Path escapes source root");
  }
  return resolved;
}

function assertContainedRealPath(sourceRoot: string, absolutePath: string): void {
  const rootReal = realpathSync(sourceRoot);
  const entryReal = realpathSync(absolutePath);
  if (!entryReal.startsWith(rootReal + path.sep) && entryReal !== rootReal) {
    throw new Error("Path escapes source root");
  }
}

export function resolveSourceFilePath(sourceRoot: string, relativePath: string): string {
  const absolute = canonicalSourcePath(sourceRoot, relativePath);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
  if (!stat.isFile()) throw new Error("Not a regular file");
  assertContainedRealPath(sourceRoot, absolute);
  return absolute;
}

export function resolveSourceDirectoryPath(sourceRoot: string, relativePath: string): string {
  const absolute = canonicalSourcePath(sourceRoot, relativePath || ".");
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
  if (!stat.isDirectory()) throw new Error("Not a directory");
  assertContainedRealPath(sourceRoot, absolute);
  return absolute;
}
