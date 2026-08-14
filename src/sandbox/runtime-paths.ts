import { realpath } from "node:fs/promises";
import path from "node:path";

export async function executableRuntimeRoot(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const canonical = await realpath(executable);
  const directory = path.dirname(canonical);
  return platform === "win32" ? directory : path.resolve(directory, "..");
}
