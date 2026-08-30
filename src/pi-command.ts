import { readFile, realpath, stat } from "node:fs/promises";
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
  if (
    piPackage.bin.length === 0 ||
    piPackage.bin.includes("\0") ||
    path.isAbsolute(piPackage.bin)
  ) {
    throw new Error("npm Pi shim does not match the installed Pi package entry point");
  }
  const lexicalDeclaredTarget = path.resolve(piPackage.root, piPackage.bin);
  if (!isWithin(piPackage.root, lexicalDeclaredTarget)) {
    throw new Error("npm Pi shim does not match the installed Pi package entry point");
  }
  const declaredTarget = await regularFileOrUndefined(lexicalDeclaredTarget);
  if (declaredTarget !== target) {
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

export async function resolvePiCommand(
  executable = "pi",
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<PiLaunchCommand> {
  if (platform !== "win32") return [executable];
  const resolved = await windowsExecutableCandidate(executable, environment);
  const extension = path.win32.extname(resolved).toLowerCase();
  if (extension === ".cmd") return await resolveNpmPiCmdShim(resolved);
  if (extension === ".bat") {
    throw new Error("Pi batch launchers are unsupported; install the npm pi.cmd shim");
  }
  return [resolved];
}
