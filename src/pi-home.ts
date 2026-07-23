import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PiHomeMode = "review" | "eval";

export interface PreparePiHomeOptions {
  readonly destination: string;
  readonly mode: PiHomeMode;
  readonly sourceDir?: string;
}

export interface PreparedPiHome {
  readonly root: string;
  readonly agentDir: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly sourceDir: string;
  readonly environment: Readonly<Record<string, string>>;
}

const MAX_ENTRIES = 100_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const ALWAYS_EXCLUDED = new Set(["sessions", "logs", ".npm", ".cache"]);

function isExcluded(name: string, mode: PiHomeMode): boolean {
  if (ALWAYS_EXCLUDED.has(name)) return true;
  if (name.endsWith("-debug.log") || name.endsWith(".log")) return true;
  return mode === "eval" && name === "skills";
}

export function defaultPiAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PI_CODING_AGENT_DIR;
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".pi", "agent");
}

async function assertMissing(candidate: string): Promise<void> {
  try {
    await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Isolated Pi home destination already exists: ${candidate}`);
}

async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  source: string,
  destination: string,
  mode: PiHomeMode,
  budget: { entries: number; bytes: number },
): Promise<void> {
  const stats = await lstat(source);
  if (!stats.isDirectory()) throw new Error(`Pi home source is not a directory: ${source}`);
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (isExcluded(entry.name, mode)) continue;
    budget.entries += 1;
    if (budget.entries > MAX_ENTRIES) throw new Error("Pi home exceeds the entry limit");
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const entryStats = await lstat(sourcePath);
    if (entryStats.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(sourcePath);
      } catch {
        throw new Error(`Pi home contains a broken symbolic link: ${sourcePath}`);
      }
      const relativeTarget = path.relative(sourceRoot, target);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error(`Pi home contains an escaping symbolic link: ${sourcePath}`);
      }
      const copiedTarget = path.join(destinationRoot, relativeTarget);
      await symlink(path.relative(path.dirname(destinationPath), copiedTarget), destinationPath);
      continue;
    }
    if (entryStats.isDirectory()) {
      await copyTree(sourceRoot, destinationRoot, sourcePath, destinationPath, mode, budget);
      continue;
    }
    if (!entryStats.isFile()) throw new Error(`Pi home contains a special file: ${sourcePath}`);
    budget.bytes += entryStats.size;
    if (budget.bytes > MAX_BYTES) throw new Error("Pi home exceeds the size limit");
    await copyFile(
      sourcePath,
      destinationPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    await chmod(destinationPath, entryStats.mode & 0o777);
  }
}

export async function prepareIsolatedPiHome(
  options: PreparePiHomeOptions,
): Promise<PreparedPiHome> {
  const sourceDir = await realpath(options.sourceDir ?? defaultPiAgentDir());
  const sourceStats = await lstat(sourceDir);
  if (!sourceStats.isDirectory())
    throw new Error(`Pi home source is not a directory: ${sourceDir}`);
  const requestedRoot = path.resolve(options.destination);
  await assertMissing(requestedRoot);
  await mkdir(path.dirname(requestedRoot), { recursive: true });
  await mkdir(requestedRoot, { mode: 0o700 });
  const root = await realpath(requestedRoot);
  const agentDir = path.join(root, "agent");
  const homeDir = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  await copyTree(sourceDir, agentDir, sourceDir, agentDir, options.mode, { entries: 0, bytes: 0 });
  await mkdir(homeDir, { mode: 0o700 });
  await mkdir(tmpDir, { mode: 0o700 });
  await access(agentDir, constants.R_OK | constants.W_OK);
  return {
    root,
    agentDir,
    homeDir,
    tmpDir,
    sourceDir,
    environment: { HOME: homeDir, TMPDIR: tmpDir, PI_CODING_AGENT_DIR: agentDir },
  };
}
