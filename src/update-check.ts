import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const PIONEER_PACKAGE_NAME = "@rock3r/pioneer";
export const PIONEER_PACKAGE_REGISTRY = "https://registry.npmjs.org/";
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
  if (leftNumber && rightNumber) {
    if (left.length !== right.length) return left.length - right.length;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function trustedNpmEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  nodeExecutable = process.execPath,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const pathApi = platform === "win32" ? path.win32 : path;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const systemRoot = source.SYSTEMROOT ?? "C:\\Windows";
  const trustedPath =
    platform === "win32"
      ? [pathApi.dirname(nodeExecutable), pathApi.join(systemRoot, "System32")].join(pathDelimiter)
      : [pathApi.dirname(nodeExecutable), "/usr/bin", "/bin"].join(pathDelimiter);
  const environment: NodeJS.ProcessEnv = { PATH: trustedPath, HOME: home };
  for (const name of [
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "COMSPEC",
    "TMP",
    "TEMP",
  ]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function npmCliCommand(
  args: readonly string[],
  nodeExecutable = process.execPath,
  platform = process.platform,
): readonly [string, ...string[]] {
  const pathApi = platform === "win32" ? path.win32 : path;
  const nodeDirectory = pathApi.dirname(nodeExecutable);
  const npmCliPath =
    platform === "win32"
      ? pathApi.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js")
      : pathApi.join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return [nodeExecutable, npmCliPath, ...args];
}

export function systemNpmCliPaths(platform = process.platform): readonly string[] {
  if (platform === "win32") return [];
  const paths = ["/opt/homebrew", "/usr/local", "/usr"].map((prefix) =>
    path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  return platform === "linux" ? [...paths, "/usr/share/nodejs/npm/bin/npm-cli.js"] : paths;
}

async function trustedNpmCommand(args: readonly string[]): Promise<readonly [string, ...string[]]> {
  const [nodeExecutable, npmCliPath, ...nodeArgs] = npmCliCommand(args);
  if (npmCliPath === undefined) throw new Error("The npm CLI path is unavailable");
  try {
    await access(npmCliPath, constants.R_OK);
    return [nodeExecutable, npmCliPath, ...nodeArgs];
  } catch {
    if (process.platform === "win32") {
      throw new Error("The npm CLI bundled with the running Node distribution is unavailable");
    }
  }
  for (const systemNpmCliPath of systemNpmCliPaths()) {
    try {
      await access(systemNpmCliPath, constants.R_OK);
      return [nodeExecutable, systemNpmCliPath, ...args];
    } catch {}
  }
  throw new Error("A trusted npm executable is unavailable");
}

export async function withIsolatedNpmConfig<T>(
  run: (configArguments: readonly [string, string], cwd: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "pioneer-npm-config-"));
  const userConfig = path.join(directory, "user.npmrc");
  const globalConfig = path.join(directory, "global.npmrc");
  try {
    await Promise.all([
      writeFile(userConfig, "", { encoding: "utf8", mode: 0o600 }),
      writeFile(globalConfig, "", { encoding: "utf8", mode: 0o600 }),
    ]);
    return await run([`--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`], directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

function runNpm(_command: string, args: readonly string[]): Promise<string> {
  return withIsolatedNpmConfig((configArguments, cwd) =>
    runNpmWithConfig([...args, ...configArguments], cwd),
  );
}

function runNpmWithConfig(args: readonly string[], cwd: string): Promise<string> {
  return trustedNpmCommand(args).then(
    ([executable, ...commandArgs]) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(executable, commandArgs, {
          cwd,
          env: trustedNpmEnvironment(),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
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
      }),
  );
}

export async function runTrustedNpm(args: readonly string[]): Promise<void> {
  await withIsolatedNpmConfig((configArguments, cwd) =>
    runTrustedNpmWithConfig([...args, ...configArguments], cwd),
  );
}

async function runTrustedNpmWithConfig(args: readonly string[], cwd: string): Promise<void> {
  const [executable, ...commandArgs] = await trustedNpmCommand(args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd,
      env: trustedNpmEnvironment(),
      shell: false,
      stdio: "inherit",
    });
    child.on("error", (error) => reject(new Error(`Could not start npm: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm exited with status ${code ?? "unknown"}`));
    });
  });
}

export async function fetchLatestVersionFromNpm(run: NpmCommandRunner = runNpm): Promise<string> {
  const output = await run("npm", [
    "view",
    PIONEER_PACKAGE_NAME,
    "version",
    "--json",
    `--registry=${PIONEER_PACKAGE_REGISTRY}`,
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
    await store
      .write({
        schemaVersion: 1,
        checkedAt: now,
        ...(cached?.latestVersion === undefined ? {} : { latestVersion: cached.latestVersion }),
      })
      .catch(() => undefined);
    throw error;
  }
}
