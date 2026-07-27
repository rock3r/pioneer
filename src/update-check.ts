import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const PIONEER_PACKAGE_NAME = "@rock3r/pioneer";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const NPM_CHECK_TIMEOUT_MS = 5_000;
const MAX_NPM_OUTPUT_BYTES = 8 * 1_024;

export interface UpdateCheckState {
  readonly schemaVersion: 1;
  readonly checkedAt: number;
  readonly latestVersion?: string;
}

export interface UpdateStateStore {
  read(): Promise<UpdateCheckState | undefined>;
  write(state: UpdateCheckState): Promise<void>;
}

export interface UpdateCheckResult {
  readonly checked: boolean;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
}

export interface UpdateCheckOptions {
  readonly currentVersion: string;
  readonly now?: number;
  readonly force?: boolean;
  readonly store?: UpdateStateStore;
  readonly lookup?: () => Promise<string>;
}

export type NpmCommandRunner = (command: string, args: readonly string[]) => Promise<string>;

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function parseVersion(value: string): SemanticVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  return left.localeCompare(right);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate);
  const currentVersion = parseVersion(current);
  if (candidateVersion === undefined || currentVersion === undefined) return false;
  for (const part of ["major", "minor", "patch"] as const) {
    if (candidateVersion[part] !== currentVersion[part]) {
      return candidateVersion[part] > currentVersion[part];
    }
  }
  if (candidateVersion.prerelease.length === 0) return currentVersion.prerelease.length > 0;
  if (currentVersion.prerelease.length === 0) return false;
  const length = Math.max(candidateVersion.prerelease.length, currentVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const candidatePart = candidateVersion.prerelease[index];
    const currentPart = currentVersion.prerelease[index];
    if (candidatePart === undefined) return false;
    if (currentPart === undefined) return true;
    const comparison = compareIdentifiers(candidatePart, currentPart);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}

function validState(value: unknown): UpdateCheckState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const checkedAt = record.checkedAt;
  if (
    record.schemaVersion !== 1 ||
    typeof checkedAt !== "number" ||
    !Number.isSafeInteger(checkedAt) ||
    checkedAt < 0
  ) {
    return undefined;
  }
  if (
    record.latestVersion !== undefined &&
    (typeof record.latestVersion !== "string" || parseVersion(record.latestVersion) === undefined)
  ) {
    return undefined;
  }
  return record.latestVersion === undefined
    ? { schemaVersion: 1, checkedAt }
    : { schemaVersion: 1, checkedAt, latestVersion: record.latestVersion };
}

export function updateCachePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredCacheRoot = environment.XDG_CACHE_HOME;
  const cacheRoot =
    configuredCacheRoot !== undefined && path.isAbsolute(configuredCacheRoot)
      ? configuredCacheRoot
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Caches")
        : path.join(homedir(), ".cache");
  return path.join(cacheRoot, "pioneer", "update-check.json");
}

export function fileUpdateStateStore(cachePath = updateCachePath()): UpdateStateStore {
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(cachePath, "utf8");
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        return undefined;
      }
      try {
        return validState(JSON.parse(text) as unknown);
      } catch {
        return undefined;
      }
    },
    async write(state) {
      const directory = path.dirname(cachePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(
        directory,
        `.update-check-${process.pid}-${crypto.randomUUID()}.json`,
      );
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, cachePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

function runNpm(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stdoutBytes = 0;
    const timer = setTimeout(() => child.kill(), NPM_CHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_NPM_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start npm for an update check: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutBytes > MAX_NPM_OUTPUT_BYTES) {
        reject(new Error("npm update check returned too much output"));
      } else if (code !== 0) {
        reject(new Error("npm update check failed"));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function fetchLatestVersionFromNpm(run: NpmCommandRunner = runNpm): Promise<string> {
  const output = await run("npm", [
    "view",
    PIONEER_PACKAGE_NAME,
    "version",
    "--json",
    "--fetch-retries=0",
    "--fetch-timeout=5000",
  ]);
  let version: unknown;
  try {
    version = JSON.parse(output) as unknown;
  } catch {
    throw new Error("npm update check did not return JSON");
  }
  if (typeof version !== "string" || parseVersion(version) === undefined) {
    throw new Error("npm update check did not return a valid semantic version");
  }
  return version;
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const now = options.now ?? Date.now();
  const store = options.store ?? fileUpdateStateStore();
  const lookup = options.lookup ?? fetchLatestVersionFromNpm;
  const cached = await store.read();
  if (
    !options.force &&
    cached !== undefined &&
    cached.checkedAt <= now &&
    now - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS
  ) {
    return {
      checked: false,
      ...(cached.latestVersion === undefined ? {} : { latestVersion: cached.latestVersion }),
      updateAvailable:
        cached.latestVersion !== undefined &&
        isNewerVersion(cached.latestVersion, options.currentVersion),
    };
  }

  try {
    const latestVersion = await lookup();
    await store.write({ schemaVersion: 1, checkedAt: now, latestVersion }).catch(() => undefined);
    return {
      checked: true,
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion, options.currentVersion),
    };
  } catch (error) {
    await store.write({ schemaVersion: 1, checkedAt: now }).catch(() => undefined);
    throw error;
  }
}
