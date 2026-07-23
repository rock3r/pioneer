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
