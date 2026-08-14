import { realpath } from "node:fs/promises";
import path from "node:path";

export async function executableRuntimeRoot(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const canonical = await realpath(executable);
  const directory = path.dirname(canonical);
  if (platform === "linux") return canonical;
  if (platform === "win32") return directory;
  return path.resolve(directory, "..");
}
