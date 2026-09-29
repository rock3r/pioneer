import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function packageRoot(candidate: string): string {
  const parts = candidate.split(path.sep);
  const cellar = parts.indexOf("Cellar");
  if (cellar >= 0 && parts.length > cellar + 2) {
    return parts.slice(0, cellar + 3).join(path.sep) || path.sep;
  }
  const optPrefix = `${path.sep}opt${path.sep}homebrew${path.sep}opt${path.sep}`;
  if (candidate.startsWith(optPrefix) && parts.length > 4) {
    return parts.slice(0, 5).join(path.sep) || path.sep;
  }
  return path.dirname(candidate);
}

export async function macosRuntimeReadPaths(executable: string): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const pending = [await realpath(executable)];
  const inspected = new Set<string>();
  const roots = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || inspected.has(current)) continue;
    inspected.add(current);
    roots.add(packageRoot(current));
    const { stdout } = await execFileAsync("/usr/bin/otool", ["-L", current], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split("\n").slice(1)) {
      const dependency = line.trim().split(" ", 1)[0];
      if (!dependency?.startsWith("/opt/homebrew/")) continue;
      roots.add(packageRoot(dependency));
      const canonical = await realpath(dependency);
      roots.add(packageRoot(canonical));
      if (!inspected.has(canonical)) pending.push(canonical);
    }
  }
  return [...roots];
}

const MACOS_SELECT_ROOT = "/private/var/select";
const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";
const XCODE_DEVELOPER_DIR = /^\/Applications\/[^/]+\.app\/Contents\/Developer$/;

/**
 * `/bin/sh` reads its shell choice from `/private/var/select/sh`, and the `/usr/bin` Git
 * shim reads `developer_dir` there and then runs the selected toolchain. Grant the selector
 * and that toolchain read-only, but only when it is a recognised developer directory.
 */
export async function macosSystemToolReadPaths(
  platform: NodeJS.Platform = process.platform,
  resolve: (candidate: string) => Promise<string> = realpath,
): Promise<string[]> {
  if (platform !== "darwin") return [];
  let selectRoot: string;
  try {
    selectRoot = await resolve(MACOS_SELECT_ROOT);
  } catch {
    return [];
  }
  if (selectRoot !== MACOS_SELECT_ROOT) return [];
  let developerDir: string;
  try {
    developerDir = await resolve(path.posix.join(MACOS_SELECT_ROOT, "developer_dir"));
  } catch {
    return [selectRoot];
  }
  const recognised = developerDir === COMMAND_LINE_TOOLS || XCODE_DEVELOPER_DIR.test(developerDir);
  return recognised ? [selectRoot, developerDir] : [selectRoot];
}
