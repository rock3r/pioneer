import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pi's private runtime storage and additional review-only extension exclusions. */
export interface PiRuntimeStorage {
  readonly agentDir: string;
  readonly sessionDirs: readonly string[];
  /** Best-effort project setting. It filters files without making a root private storage. */
  readonly repositorySessionDirs?: readonly string[];
}

const MAX_REPOSITORY_SETTINGS_BYTES = 64 * 1024;

/** Pi's Windows conversion of Git Bash, MSYS, Cygwin, and WSL drive paths. Non-Unicode /i folds ASCII only. */
function normalizeWindowsShellPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return value;
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match?.[1]) return value;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** Mirrors Pi's normalizePath. Relative paths need a known Pi working directory. */
function normalizeSessionDir(input: string, home: string, repositorySource?: string): string {
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
  if (repositorySource === undefined && !path.isAbsolute(value))
    throw new Error(
      "[PI_SESSION_DIR_RELATIVE] Pi's configured session directory is relative. Use an absolute path or one starting with ~/ so Pioneer can keep private sessions out of snapshots.",
    );
  return repositorySource === undefined
    ? path.resolve(value)
    : path.resolve(repositorySource, value);
}

function configuredSessionDir(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let settings: unknown;
  try {
    // Pi strips a leading byte order mark before parsing settings.
    settings = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    return undefined;
  }
  if (typeof settings !== "object" || settings === null) return undefined;
  const configured = (settings as Record<string, unknown>).sessionDir;
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

function sameSettingsFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.ino !== 0n &&
    before.ino === after.ino &&
    before.dev === after.dev &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function readRepositorySettings(source: string): Promise<string | undefined> {
  const settings = path.join(source, ".pi", "settings.json");
  const canonical = await realpath(settings);
  const relative = path.relative(source, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return undefined;

  const before = await lstat(canonical, { bigint: true });
  if (!before.isFile()) return undefined;
  // The handle must be the validated regular file. Do not follow a replaced final link or
  // wait for a writer if the file changed to a FIFO before open.
  const handle = await open(
    canonical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAX_REPOSITORY_SETTINGS_BYTES) ||
      !sameSettingsFile(before, opened) ||
      (await realpath(settings)) !== canonical ||
      !sameSettingsFile(opened, await lstat(canonical, { bigint: true }))
    )
      return undefined;
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    if (!sameSettingsFile(opened, await handle.stat({ bigint: true }))) return undefined;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } finally {
    await handle.close();
  }
}

async function repositorySessionDirs(source: string, home: string): Promise<string[]> {
  try {
    const value = configuredSessionDir(await readRepositorySettings(source));
    if (value === undefined) return [];
    const resolved = normalizeSessionDir(value, home, source);
    if (resolved.includes("\0")) return [];
    const canonical = await realpath(resolved).catch(() => resolved);
    return canonical === resolved ? [resolved] : [resolved, canonical];
  } catch {
    // Untrusted project settings only provide a best-effort, review-local exclusion.
    return [];
  }
}

/**
 * Locates the session directories Pi would use. Tildes expand against the Pi environment's home.
 * Pi ignores unparseable settings and falls back to its default session directory, so this does too.
 * Only a review supplies a canonical repository source for the extra extension filter.
 */
export async function piRuntimeStorage(
  agentDir: string,
  settingsFile: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  repositorySource?: string,
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
  const configured = configuredSessionDir(text);
  if (configured !== undefined) sessionDirs.push(normalizeSessionDir(configured, home));
  return repositorySource === undefined
    ? { agentDir, sessionDirs }
    : {
        agentDir,
        sessionDirs,
        repositorySessionDirs: await repositorySessionDirs(repositorySource, home),
      };
}
