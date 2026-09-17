import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Pi's private runtime storage. Snapshots exclude these exact locations. */
export interface PiRuntimeStorage {
  readonly agentDir: string;
  readonly sessionDirs: readonly string[];
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    return path.join(home, value.slice(2));
  return path.resolve(value);
}

/**
 * Locates the session directories Pi would use. Tildes expand against the Pi environment's home.
 * Pi ignores unparseable settings and falls back to its default session directory, so this does too.
 */
export async function piRuntimeStorage(
  agentDir: string,
  settingsFile: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PiRuntimeStorage> {
  const home =
    environment.HOME ||
    (process.platform === "win32" ? environment.USERPROFILE : undefined) ||
    os.homedir();
  const sessionDirs: string[] = [];
  const fromEnvironment = environment.PI_CODING_AGENT_SESSION_DIR;
  if (fromEnvironment) sessionDirs.push(expandHome(fromEnvironment, home));
  let text: string | undefined;
  try {
    text = await readFile(settingsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "[PI_RUNTIME_STORAGE_UNREADABLE] Pi settings could not be read to locate private session storage.",
      );
  }
  let settings: unknown;
  try {
    settings = text === undefined ? undefined : JSON.parse(text);
  } catch {
    settings = undefined;
  }
  if (typeof settings === "object" && settings !== null) {
    const configured = (settings as Record<string, unknown>).sessionDir;
    if (typeof configured === "string" && configured.length > 0)
      sessionDirs.push(expandHome(configured, home));
  }
  return { agentDir, sessionDirs };
}
