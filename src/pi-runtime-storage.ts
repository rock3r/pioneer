import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pi's private runtime storage. Snapshots exclude these exact locations. */
export interface PiRuntimeStorage {
  readonly agentDir: string;
  readonly sessionDirs: readonly string[];
}

/** Pi's Windows conversion of Git Bash, MSYS, Cygwin, and WSL drive paths. Non-Unicode /i folds ASCII only. */
function normalizeWindowsShellPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return value;
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match?.[1]) return value;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** Mirrors Pi's normalizePath for session directories, then requires an absolute result. */
function normalizeSessionDir(input: string, home: string): string {
  let value = process.platform === "win32" ? normalizeWindowsShellPath(input) : input;
  if (value === "~") value = home;
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    value = path.join(home, value.slice(2));
  else if (/^file:\/\//u.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      throw new Error(
        "[PI_SESSION_DIR_INVALID] Pi's configured session directory is not a valid local file URL.",
      );
    }
  }
  // Pi resolves a relative value against its own working directory, which Pioneer cannot know.
  if (!path.isAbsolute(value))
    throw new Error(
      "[PI_SESSION_DIR_RELATIVE] Pi's configured session directory is relative. Use an absolute path or one starting with ~/ so Pioneer can keep private sessions out of snapshots.",
    );
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
  // Match os.homedir(): Windows prefers USERPROFILE, other platforms use HOME.
  const home =
    (process.platform === "win32"
      ? environment.USERPROFILE || environment.HOME
      : environment.HOME) || os.homedir();
  const sessionDirs: string[] = [];
  const fromEnvironment = environment.PI_CODING_AGENT_SESSION_DIR;
  if (fromEnvironment) sessionDirs.push(normalizeSessionDir(fromEnvironment, home));
  let text: string | undefined;
  try {
    text = await readFile(settingsFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      throw new Error(
        `[PI_RUNTIME_STORAGE_UNREADABLE] Pi settings could not be read to locate private session storage (${code ?? "unknown error"}).`,
        { cause: error },
      );
  }
  let settings: unknown;
  try {
    // Pi strips a leading byte order mark before parsing settings.
    settings = text === undefined ? undefined : JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    settings = undefined;
  }
  if (typeof settings === "object" && settings !== null) {
    const configured = (settings as Record<string, unknown>).sessionDir;
    if (typeof configured === "string" && configured.length > 0)
      sessionDirs.push(normalizeSessionDir(configured, home));
  }
  return { agentDir, sessionDirs };
}
