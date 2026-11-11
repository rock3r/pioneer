import { constants } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type PiLaunchCommand = readonly [string, ...string[]];

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_SHIM_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_ASCENT = 8;
const DIRECT_WINDOWS_PATH_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);
const NPM_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
].join("\r\n");
const NPM_SHIM_TARGET =
  /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (?:set PATHEXT=%PATHEXT:;.JS;=;% & )?"%_prog%"[ \t]+"%dp0%\\([^"\r\n]+)" %\*\r?$/m;
const BATCH_META_CHARACTER = /[%!^&|<>"\0]/;

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  requestedName: string,
): string | undefined {
  return Object.entries(environment).find(
    ([name]) => name.toLowerCase() === requestedName.toLowerCase(),
  )?.[1];
}

function windowsPathExtensions(environment: Readonly<NodeJS.ProcessEnv>): string[] {
  return (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => DIRECT_WINDOWS_PATH_EXTENSIONS.has(extension));
}

function windowsPathEntries(value: string): string[] {
  const entries: string[] = [];
  let entry = "";
  let quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (character === ";" && !quoted) {
      entries.push(entry);
      entry = "";
    } else {
      entry += character;
    }
  }
  entries.push(entry);
  return entries;
}

async function regularFileOrUndefined(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function notFound(executable: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Pi executable was not found on PATH: ${executable}`), {
    code: "ENOENT",
  });
}

async function readBounded(filename: string, limit: number): Promise<string> {
  const details = await stat(filename);
  if (!details.isFile() || details.size > limit)
    throw new Error("file is not a bounded regular file");
  return await readFile(filename, "utf8");
}

function manifestPiBin(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const record = manifest as Record<string, unknown>;
  if (record.name !== PI_PACKAGE_NAME) return undefined;
  if (typeof record.bin === "string") return record.bin;
  if (typeof record.bin !== "object" || record.bin === null) return undefined;
  const pi = (record.bin as Record<string, unknown>).pi;
  return typeof pi === "string" ? pi : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function findOwningPiPackage(target: string): Promise<{
  readonly root: string;
  readonly bin: string;
}> {
  let directory = path.dirname(target);
  for (let depth = 0; depth < MAX_PACKAGE_ASCENT; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readBounded(manifestPath, MAX_MANIFEST_BYTES)) as unknown;
      const bin = manifestPiBin(manifest);
      if (bin !== undefined) return { root: directory, bin };
    } catch {
      // Keep the search bounded and accept only the exact Pi package manifest.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("npm Pi shim target is not owned by the installed Pi package");
}

/** The canonical declared `pi` entry point of an official package, if it stays inside it. */
async function declaredPiEntryPoint(piPackage: {
  readonly root: string;
  readonly bin: string;
}): Promise<string | undefined> {
  if (piPackage.bin.length === 0 || piPackage.bin.includes("\0") || path.isAbsolute(piPackage.bin))
    return undefined;
  const lexical = path.resolve(piPackage.root, piPackage.bin);
  if (!isWithin(piPackage.root, lexical)) return undefined;
  return await regularFileOrUndefined(lexical);
}

const MANAGED_INSTALL_MARKER = "managed-install.json";
const MAX_MANAGED_FILE_BYTES = 64 * 1024;
const MAX_MANAGED_VERSION_BYTES = 1024;
// The managed launcher accepts these characters and rejects "." and "..".
const MANAGED_RELEASE_VERSION = /^[0-9A-Za-z._+-]+$/;

function isManagedReleaseVersion(version: string): boolean {
  return MANAGED_RELEASE_VERSION.test(version) && version !== "." && version !== "..";
}

/** Whether a directory carries Pi's `releases-v1` managed-install marker. */
async function isManagedInstallRoot(installRoot: string): Promise<boolean> {
  try {
    const marker = JSON.parse(
      (
        await readBounded(path.join(installRoot, MANAGED_INSTALL_MARKER), MAX_MANAGED_FILE_BYTES)
      ).replace(/^\uFEFF/, ""),
    ) as unknown;
    if (typeof marker !== "object" || marker === null) return false;
    const record = marker as Record<string, unknown>;
    return (
      record.kind === "pi-managed-install" &&
      record.schemaVersion === 1 &&
      record.layout === "releases-v1"
    );
  } catch {
    return false;
  }
}

/**
 * Resolve Pi's managed-installer launcher (`<agent>/bin/pi`) to the canonical `pi` entry
 * point of its current release, `<agent>/install/releases/<version>/node_modules`, without
 * running the launcher. Anything else, or any layout that fails validation, returns
 * undefined so callers keep their existing fail-closed handling.
 */
export async function resolveManagedPiLauncher(launcher: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(launcher);
    const binDirectory = path.dirname(canonical);
    if (path.basename(canonical) !== "pi" || path.basename(binDirectory) !== "bin")
      return undefined;
    const contents = await readBounded(canonical, MAX_MANAGED_FILE_BYTES);
    if (!contents.startsWith("#!/bin/sh\n") || !contents.includes("PI_MANAGED_INSTALL_ROOT"))
      return undefined;
    const installRoot = path.join(path.dirname(binDirectory), "install");
    if (!(await isManagedInstallRoot(installRoot))) return undefined;
    // The launcher reads one newline-terminated line with `IFS= read -r`.
    const current = await readBounded(
      path.join(installRoot, "current-version"),
      MAX_MANAGED_VERSION_BYTES,
    );
    const newline = current.indexOf("\n");
    const version = newline < 0 ? "" : current.slice(0, newline);
    if (!isManagedReleaseVersion(version)) return undefined;
    const expectedNodeModules = path.join(
      await realpath(installRoot),
      "releases",
      version,
      "node_modules",
    );
    // Reject a release directory that links elsewhere; its contents are granted read-only.
    if ((await realpath(expectedNodeModules)) !== expectedNodeModules) return undefined;
    const target = await regularFileOrUndefined(path.join(expectedNodeModules, ".bin", "pi"));
    if (target === undefined) return undefined;
    await access(target, constants.X_OK);
    const piPackage = await findOwningPiPackage(target);
    if (piPackage.root !== path.join(expectedNodeModules, "@earendil-works", "pi-coding-agent"))
      return undefined;
    return (await declaredPiEntryPoint(piPackage)) === target ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The read-only grant that lets an official Pi package load its dependencies. npm installs
 * a managed release with its dependencies hoisted beside the package, so that release's
 * `node_modules` is granted. It holds only the release's npm packages, not Pi's
 * configuration or credentials. Every other layout keeps the package directory itself, so a
 * global npm prefix never exposes unrelated packages.
 */
export async function piPackageReadRoot(packageRoot: string): Promise<string> {
  const scope = path.dirname(packageRoot);
  const nodeModules = path.dirname(scope);
  const release = path.dirname(nodeModules);
  const releases = path.dirname(release);
  if (
    path.basename(packageRoot) !== "pi-coding-agent" ||
    path.basename(scope) !== "@earendil-works" ||
    path.basename(nodeModules) !== "node_modules" ||
    path.basename(releases) !== "releases" ||
    !isManagedReleaseVersion(path.basename(release)) ||
    !(await isManagedInstallRoot(path.dirname(releases)))
  )
    return packageRoot;
  return nodeModules;
}

export async function resolveNpmPiCmdShim(
  shimPath: string,
  nodeExecutable = process.execPath,
): Promise<PiLaunchCommand> {
  if (!path.isAbsolute(nodeExecutable)) {
    throw new Error("Node executable for npm Pi shim resolution must be absolute");
  }
  let contents: string;
  try {
    contents = await readBounded(shimPath, MAX_SHIM_BYTES);
  } catch {
    throw new Error("pi.cmd is not a recognized npm Pi shim");
  }
  if (!contents.startsWith(NPM_SHIM_PREFIX)) {
    throw new Error("pi.cmd is not a recognized npm Pi shim");
  }
  const relativeTarget = NPM_SHIM_TARGET.exec(contents)?.[1];
  if (
    relativeTarget === undefined ||
    relativeTarget.length === 0 ||
    path.win32.isAbsolute(relativeTarget) ||
    relativeTarget.includes(":") ||
    BATCH_META_CHARACTER.test(relativeTarget)
  ) {
    throw new Error("pi.cmd is not a recognized npm Pi shim");
  }

  const lexicalTarget = path.resolve(
    path.dirname(shimPath),
    relativeTarget.replaceAll("\\", path.sep),
  );
  const target = await regularFileOrUndefined(lexicalTarget);
  if (target === undefined) throw new Error("npm Pi shim target is missing or not a regular file");
  const piPackage = await findOwningPiPackage(target);
  if ((await declaredPiEntryPoint(piPackage)) !== target) {
    throw new Error("npm Pi shim does not match the installed Pi package entry point");
  }
  return [nodeExecutable, target];
}

async function windowsExecutableCandidate(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  const hasSeparator = executable.includes("/") || executable.includes("\\");
  const bases = path.win32.isAbsolute(executable)
    ? [executable]
    : hasSeparator
      ? [path.resolve(executable)]
      : windowsPathEntries(environmentValue(environment, "PATH") ?? "")
          .map((entry) =>
            entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry,
          )
          .filter((entry) => entry.length > 0)
          .map((entry) => path.join(entry, executable));
  const hasExtension = path.win32.extname(executable).length > 0;
  const extensions = hasExtension
    ? [""]
    : hasSeparator
      ? ["", ...windowsPathExtensions(environment)]
      : windowsPathExtensions(environment);
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = await regularFileOrUndefined(`${base}${extension}`);
      if (candidate !== undefined) return candidate;
    }
  }
  throw notFound(executable);
}

async function posixExecutableCandidate(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  const pathValue = environment.PATH;
  if (!executable.includes("/") && pathValue === undefined) throw notFound(executable);
  // An empty PATH component is the current directory, as in PATH=:/usr/bin.
  const bases = executable.includes("/")
    ? [path.resolve(executable)]
    : (pathValue ?? "")
        .split(path.delimiter)
        .map((entry) => path.join(entry.length === 0 ? process.cwd() : entry, executable));
  for (const base of bases) {
    const candidate = await regularFileOrUndefined(base);
    if (candidate === undefined) continue;
    try {
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  throw notFound(executable);
}

async function usesEnvNodeShebang(script: string): Promise<boolean> {
  const handle = await open(script, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]?.trim() ?? "";
    return line === "#!/usr/bin/env node";
  } finally {
    await handle.close();
  }
}

export async function resolvePiCommand(
  executable = "pi",
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<PiLaunchCommand> {
  // Return the canonical file. A PATH symlink often lives outside the package, and the
  // sandbox grants the package directory rather than that external launcher.
  if (platform !== "win32") {
    const found = await posixExecutableCandidate(executable, environment);
    // Pi's managed installer puts a shell launcher on PATH. Launch its current release's
    // entry point directly, as the launcher would, so the sandbox grants that release.
    const script = (await resolveManagedPiLauncher(found)) ?? found;
    // Launch through the absolute node binary. A PATH symlink such as Homebrew's
    // node is not mounted, so the script's env shebang cannot find it.
    if (await usesEnvNodeShebang(script)) {
      try {
        const nodePath = await posixExecutableCandidate("node", environment);
        if (nodePath !== script) return [nodePath, script];
      } catch {
        // This PATH has the script but not node. Keep the script path.
      }
    }
    return [script];
  }
  const resolved = await windowsExecutableCandidate(executable, environment);
  const extension = path.win32.extname(resolved).toLowerCase();
  if (extension === ".cmd") return await resolveNpmPiCmdShim(resolved);
  if (extension === ".bat") {
    throw new Error("Pi batch launchers are unsupported; install the npm pi.cmd shim");
  }
  return [resolved];
}
