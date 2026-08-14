import { access, constants, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { diagnosticMessage } from "../diagnostics.js";
import type { SandboxPolicy } from "../sandbox/launcher.js";

export type EvalPlatform = "darwin" | "linux" | "win32";

export interface EvalRunSpec {
  readonly runDir: string;
  readonly command: readonly [string, ...string[]];
  readonly runtimeReadPaths?: readonly string[];
  readonly piHomeSource?: string;
}

export interface ValidatedEvalRunSpec {
  readonly runDir: string;
  readonly command: readonly [string, ...string[]];
  readonly runtimeReadPaths: readonly string[];
  readonly piHomeSource?: string;
}

export interface ResolvedEvalExecutable {
  readonly commandPath: string;
  readonly command?: readonly [string, ...string[]];
  readonly readPaths: readonly string[];
}

export interface EvalSandboxConfigOptions {
  readonly platform: EvalPlatform;
  readonly runDir: string;
  readonly runtimeReadPaths: readonly string[];
  readonly parentProxyUrl: string;
}

export interface ValidatedPiInstallation {
  readonly packageRoot: string;
}

export function isTrustedPiInstallation(
  candidate: ValidatedPiInstallation | undefined,
  trusted: ValidatedPiInstallation | undefined,
): boolean {
  return (
    candidate !== undefined &&
    trusted !== undefined &&
    candidate.packageRoot === trusted.packageRoot
  );
}

const BROAD_READ_POSIX_PATHS = new Set([
  "/",
  "/Users",
  "/dev",
  "/etc",
  "/home",
  "/private",
  "/private/etc",
  "/private/tmp",
  "/private/var",
  "/private/var/folders",
  "/private/var/tmp",
  "/root",
  "/run",
  "/tmp",
  "/var",
  "/var/tmp",
]);
const BROAD_WRITABLE_POSIX_PATHS = new Set([
  ...BROAD_READ_POSIX_PATHS,
  "/Applications",
  "/Library",
  "/Network",
  "/System",
  "/Volumes",
  "/bin",
  "/boot",
  "/cores",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
]);
const PROTECTED_WRITABLE_POSIX_ROOTS = [
  "/Applications",
  "/Library",
  "/Network",
  "/System",
  "/Volumes",
  "/bin",
  "/boot",
  "/cores",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/private/etc",
  "/private/var",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
] as const;
const COMMON_DISPOSABLE_WRITABLE_TEMP_ROOTS = ["/tmp", "/var/tmp"] as const;
const DARWIN_DISPOSABLE_WRITABLE_TEMP_ROOTS = ["/private/tmp", "/private/var/tmp"] as const;
const CANONICAL_HOME_DIR = (() => {
  try {
    return realpathSync.native(os.homedir());
  } catch {
    return path.resolve(os.homedir());
  }
})();
export const MAX_SHEBANG_READ_BYTES = 4_096;
export const MAX_SHEBANG_RESOLUTION_DEPTH = 16;
const SHEBANG_RESOLUTION_FAILURE = diagnosticMessage(
  "EVAL_SHEBANG_RESOLUTION_FAILED",
  "Eval actor shebang resolution exceeded its safe cycle or depth bound",
);

interface ShebangResolutionContext {
  readonly depth: number;
  readonly canonicalPaths: ReadonlySet<string>;
}

interface ParsedEnvShebang {
  readonly interpreter: string;
  readonly arguments: readonly string[];
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || (process.platform === "win32" && value.includes("\\"));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function assertExecutable(candidate: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
    const details = await stat(canonical);
    if (!details.isFile()) throw new Error("not a regular file");
    if (process.platform === "win32") {
      const extension = path.win32.extname(canonical).toLowerCase();
      if (extension.length > 0 && !windowsPathExtensions().includes(extension)) {
        throw new Error("not a Windows executable");
      }
    } else {
      await new Promise<void>((resolve, reject) =>
        access(canonical, constants.X_OK, (error) => (error ? reject(error) : resolve())),
      );
    }
  } catch {
    throw new Error(`Eval actor executable is missing or not executable: ${candidate}`);
  }
  return canonical;
}

function windowsPathExtensions(): string[] {
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function selectedPathCandidates(entry: string, executable: string): string[] {
  const base = path.join(entry, executable);
  if (process.platform !== "win32" || path.win32.extname(executable).length > 0) return [base];
  const extensions = windowsPathExtensions();
  return [base, ...extensions.map((extension) => `${base}${extension}`)];
}

async function readShebangFirstLine(executable: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(executable, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const details = await handle.stat();
    if (!details.isFile()) return "";
    if (process.platform !== "win32" && (details.mode & 0o111) === 0) return "";
    const buffer = Buffer.alloc(MAX_SHEBANG_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newlineIndex >= 0) {
      return buffer.subarray(0, newlineIndex).toString("utf8");
    }
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const { size } = await handle.stat();
    if (bytesRead === buffer.length && size > buffer.length && prefix.startsWith("#!")) {
      throw new Error(SHEBANG_RESOLUTION_FAILURE);
    }
    return prefix;
  } catch (error) {
    if (error instanceof Error && error.message === SHEBANG_RESOLUTION_FAILURE) throw error;
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseEnvShebang(firstLine: string): ParsedEnvShebang | undefined {
  const match = firstLine.match(/^#!\s*\/usr\/bin\/env\s+(.+?)\s*$/);
  if (!match?.[1]) return undefined;
  const shebangArguments = match[1].trim();
  if (!/^-S(?:\s|$)/.test(shebangArguments)) {
    if (shebangArguments.startsWith("-")) throw new Error(SHEBANG_RESOLUTION_FAILURE);
    return { interpreter: shebangArguments, arguments: [] };
  }
  const tokens = splitEnvShebangArguments(match[1]);
  const firstToken = tokens[0];
  if (firstToken === "-S") {
    if (match[1].includes("$")) throw new Error(SHEBANG_RESOLUTION_FAILURE);
    tokens.shift();
    if (tokens[0] === "--") tokens.shift();
  } else if (tokens.length !== 1) throw new Error(SHEBANG_RESOLUTION_FAILURE);
  if (!tokens[0] || tokens[0].startsWith("-")) {
    throw new Error(SHEBANG_RESOLUTION_FAILURE);
  }
  return { interpreter: tokens[0], arguments: tokens.slice(1) };
}

function splitEnvShebangArguments(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;
  const pushToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(current);
    current = "";
    tokenStarted = false;
  };
  const appendEscape = (character: string): void => {
    if (character === "_") throw new Error(SHEBANG_RESOLUTION_FAILURE);
    const escapedValues: Readonly<Record<string, string>> = {
      $: "$",
      "'": "'",
      '"': '"',
      "\\": "\\",
      "#": "#",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    const replacement = escapedValues[character];
    if (replacement === undefined) throw new Error(SHEBANG_RESOLUTION_FAILURE);
    current += replacement;
    tokenStarted = true;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else if (character === "\\" && ["'", "\\"].includes(value[index + 1] ?? "")) {
        current += value[index + 1];
        index += 1;
      } else current += character;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\") {
        index += 1;
        if (index >= value.length) throw new Error(SHEBANG_RESOLUTION_FAILURE);
        const escapedCharacter = value[index];
        if (escapedCharacter === undefined) throw new Error(SHEBANG_RESOLUTION_FAILURE);
        appendEscape(escapedCharacter);
      } else current += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index >= value.length) throw new Error(SHEBANG_RESOLUTION_FAILURE);
      const escapedCharacter = value[index];
      if (escapedCharacter === undefined) throw new Error(SHEBANG_RESOLUTION_FAILURE);
      appendEscape(escapedCharacter);
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    if (character === "#" && !tokenStarted) break;
    current += character;
    tokenStarted = true;
  }
  if (quote !== undefined) throw new Error(SHEBANG_RESOLUTION_FAILURE);
  pushToken();
  return tokens;
}

async function resolveShebangInterpreter(
  executable: string,
  runDir: string,
  selectedPath: string,
  context: ShebangResolutionContext,
): Promise<ResolvedEvalExecutable | undefined> {
  const firstLine = await readShebangFirstLine(executable);
  const parsed = parseEnvShebang(firstLine);
  if (parsed === undefined) return undefined;
  const interpreter = await resolveEvalExecutableInternal(
    parsed.interpreter,
    runDir,
    selectedPath,
    {
      depth: context.depth + 1,
      canonicalPaths: new Set([...context.canonicalPaths, executable]),
    },
  );
  if (parsed.arguments.length === 0) return interpreter;
  return {
    ...interpreter,
    command: [
      ...(interpreter.command ?? [interpreter.readPaths[0] ?? interpreter.commandPath]),
      ...parsed.arguments,
    ] as [string, ...string[]],
  };
}

async function buildResolvedExecutable(
  lexicalPath: string,
  canonical: string,
  runDir: string,
  selectedPath: string,
  context: ShebangResolutionContext,
): Promise<ResolvedEvalExecutable> {
  if (context.depth >= MAX_SHEBANG_RESOLUTION_DEPTH || context.canonicalPaths.has(canonical)) {
    throw new Error(SHEBANG_RESOLUTION_FAILURE);
  }
  const interpreter = await resolveShebangInterpreter(canonical, runDir, selectedPath, {
    depth: context.depth,
    canonicalPaths: new Set([...context.canonicalPaths, canonical]),
  });
  return {
    commandPath: canonical,
    ...(interpreter === undefined
      ? {}
      : {
          command: [
            ...(interpreter.command ?? [interpreter.readPaths[0] ?? interpreter.commandPath]),
            lexicalPath,
          ] as [string, ...string[]],
        }),
    readPaths: [lexicalPath, canonical, ...(interpreter?.readPaths ?? [])].filter(
      (value, index, all) => all.indexOf(value) === index,
    ),
  };
}

async function resolveEvalExecutableInternal(
  executable: string,
  runDir: string,
  selectedPath: string,
  context: ShebangResolutionContext,
): Promise<ResolvedEvalExecutable> {
  if (executable.length === 0 || executable.includes("\0")) {
    throw new Error("Eval actor executable must be a non-empty, non-NUL path");
  }
  const lexicalPath = path.isAbsolute(executable)
    ? path.normalize(executable)
    : hasPathSeparator(executable)
      ? path.resolve(runDir, executable)
      : undefined;
  if (lexicalPath !== undefined && !path.isAbsolute(executable) && !isWithin(runDir, lexicalPath)) {
    throw new Error("Eval actor relative executable must remain inside its run directory");
  }
  if (lexicalPath === undefined) {
    for (const entry of selectedPath.split(path.delimiter)) {
      if (entry.length === 0 || !path.isAbsolute(entry)) continue;
      for (const candidate of selectedPathCandidates(entry, executable)) {
        let canonical: string;
        try {
          canonical = await assertExecutable(candidate);
        } catch {
          // Continue through explicitly selected PATH entries only when this candidate was not executable.
          continue;
        }
        return await buildResolvedExecutable(candidate, canonical, runDir, selectedPath, context);
      }
    }
    throw new Error(`Eval actor executable was not found on the selected PATH: ${executable}`);
  }
  const canonical = await assertExecutable(lexicalPath);
  return await buildResolvedExecutable(lexicalPath, canonical, runDir, selectedPath, context);
}

export async function resolveEvalExecutable(
  executable: string,
  runDir: string,
  selectedPath: string,
): Promise<ResolvedEvalExecutable> {
  return await resolveEvalExecutableInternal(executable, runDir, selectedPath, {
    depth: 0,
    canonicalPaths: new Set(),
  });
}

export function buildEvalExecutableReadPaths(
  resolved: ResolvedEvalExecutable,
  piInstallation?: ValidatedPiInstallation,
): string[] {
  const readPaths = [...resolved.readPaths];
  if (piInstallation !== undefined) {
    const scriptDirectory = path.dirname(resolved.commandPath);
    if (!isWithin(piInstallation.packageRoot, scriptDirectory)) {
      throw new Error("Validated Pi package root does not contain its executable");
    }
    readPaths.push(scriptDirectory, piInstallation.packageRoot);
  }
  return readPaths.filter((value, index, all) => all.indexOf(value) === index);
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_PI_PACKAGE_MANIFEST_BYTES = 64 * 1024;

async function readBoundedPiPackageManifest(manifestPath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_PI_PACKAGE_MANIFEST_BYTES) return undefined;
    const buffer = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function findValidatedPiPackageRoot(
  executablePath: string,
  excludedRunDir?: string,
): Promise<ValidatedPiInstallation | undefined> {
  let canonicalExcludedRunDir: string | undefined;
  if (excludedRunDir !== undefined) {
    try {
      canonicalExcludedRunDir = await realpath(excludedRunDir);
    } catch {
      return undefined;
    }
  }
  let canonicalExecutablePath: string;
  try {
    canonicalExecutablePath = await realpath(executablePath);
  } catch {
    return undefined;
  }
  let current = path.dirname(canonicalExecutablePath);
  for (;;) {
    try {
      const manifestPath = path.join(current, "package.json");
      const contents = await readBoundedPiPackageManifest(manifestPath);
      if (contents === undefined) throw new Error("manifest unavailable");
      const manifest = JSON.parse(contents) as unknown;
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        manifest.name === PI_PACKAGE_NAME &&
        !isBroadRuntimePath(current) &&
        (canonicalExcludedRunDir === undefined ||
          (!isWithin(current, canonicalExcludedRunDir) &&
            !isWithin(canonicalExcludedRunDir, current)))
      ) {
        return { packageRoot: current };
      }
    } catch {
      // An unreadable or invalid manifest does not identify a validated Pi installation.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function assertNoSymlinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error(`Actor-visible eval run contains a symbolic link: ${candidate}`);
    }
    if (stats.isDirectory()) {
      await assertNoSymlinks(candidate);
    }
  }
}

function isBroadRuntimePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    const parsed = path.win32.parse(candidate);
    return candidate.toLowerCase() === parsed.root.toLowerCase();
  }
  return (
    BROAD_READ_POSIX_PATHS.has(candidate) ||
    candidate === path.resolve(os.homedir()) ||
    candidate === CANONICAL_HOME_DIR
  );
}

function isBroadWritablePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isBroadRuntimePath(candidate, platform)) return true;
  const disposableTempRoots =
    platform === "darwin"
      ? [...COMMON_DISPOSABLE_WRITABLE_TEMP_ROOTS, ...DARWIN_DISPOSABLE_WRITABLE_TEMP_ROOTS]
      : COMMON_DISPOSABLE_WRITABLE_TEMP_ROOTS;
  if (
    platform !== "win32" &&
    (disposableTempRoots.some((root) => isWithin(root, candidate)) ||
      (platform === "darwin" && isDarwinPerUserTempDescendant(candidate)))
  ) {
    return false;
  }
  return (
    BROAD_WRITABLE_POSIX_PATHS.has(candidate) ||
    (platform !== "win32" &&
      PROTECTED_WRITABLE_POSIX_ROOTS.some((root) => isWithin(root, candidate)))
  );
}

function isDarwinPerUserTempDescendant(candidate: string): boolean {
  const relative = path.posix.relative("/private/var/folders", candidate);
  const parts = relative.split("/");
  return (
    !relative.startsWith("../") &&
    !path.posix.isAbsolute(relative) &&
    parts[2] === "T" &&
    parts.length > 3
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

export async function validateEvalRunSpec(spec: EvalRunSpec): Promise<ValidatedEvalRunSpec> {
  if (spec.command.length === 0 || spec.command.some((argument) => argument.includes("\0"))) {
    throw new Error("Eval command must contain non-NUL argv entries");
  }
  const runDir = await realpath(spec.runDir);
  if (isBroadWritablePath(runDir)) {
    throw new Error(`Refusing broad eval run directory: ${runDir}`);
  }
  const stats = await lstat(runDir);
  if (!stats.isDirectory()) {
    throw new Error(`Eval run directory is not a directory: ${runDir}`);
  }
  await assertNoSymlinks(runDir);

  const runtimeReadPaths: string[] = [];
  for (const runtimePath of spec.runtimeReadPaths ?? []) {
    const canonical = await realpath(runtimePath);
    if (isBroadRuntimePath(canonical)) {
      throw new Error(`Refusing broad runtime read path: ${canonical}`);
    }
    if (pathsOverlap(runDir, canonical)) {
      throw new Error(
        `Runtime read path must not overlap the writable run directory: ${canonical}`,
      );
    }
    if (!runtimeReadPaths.includes(canonical)) {
      runtimeReadPaths.push(canonical);
    }
  }
  const piHomeSource =
    spec.piHomeSource === undefined ? undefined : await realpath(spec.piHomeSource);
  if (piHomeSource !== undefined && !(await lstat(piHomeSource)).isDirectory()) {
    throw new Error(`Pi home source is not a directory: ${piHomeSource}`);
  }
  return {
    runDir,
    command: spec.command,
    runtimeReadPaths,
    ...(piHomeSource === undefined ? {} : { piHomeSource }),
  };
}

function parseIpv4(address: string): number | undefined {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

const NON_PUBLIC_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

function parseIpv6(address: string): number[] | undefined {
  const withoutZone = address.split("%", 1)[0]?.toLowerCase();
  if (withoutZone === undefined) {
    return undefined;
  }
  let input = withoutZone;
  const ipv4Match = input.match(/([^:]+\.[^:]+)$/);
  if (ipv4Match?.[1]) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (ipv4 === undefined) {
      return undefined;
    }
    input =
      input.slice(0, -ipv4Match[1].length) +
      `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1]?.split(":") ?? []);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return undefined;
  }
  const groups = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ].map((group) => Number.parseInt(group, 16));
  if (
    groups.length !== 8 ||
    groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  ) {
    return undefined;
  }
  return groups;
}

function isPublicIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) {
    return false;
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && g7 === 1)
  ) {
    return false;
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicInternetAddress(`${g6 >>> 8}.${g6 & 255}.${g7 >>> 8}.${g7 & 255}`);
  }
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) {
    return false;
  }
  if (
    (g0 === 0x0064 && g1 === 0xff9b) ||
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) ||
    (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8 || (g1 & 0xfff0) === 0x0010)) ||
    g0 === 0x2002 ||
    (g0 & 0xfff0) === 0x3ff0
  ) {
    return false;
  }
  return (g0 & 0xe000) === 0x2000;
}

export function isPublicInternetAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const value = parseIpv4(address);
    return (
      value !== undefined &&
      !NON_PUBLIC_IPV4_RANGES.some(([base, prefix]) => {
        const baseValue = parseIpv4(base);
        return baseValue !== undefined && inIpv4Range(value, baseValue, prefix);
      })
    );
  }
  return family === 6 && isPublicIpv6(address);
}

export function buildEvalSandboxConfig(options: EvalSandboxConfigOptions): SandboxPolicy {
  if (options.platform === "win32") {
    throw new Error("Strict eval filesystem isolation is unavailable on Windows");
  }
  if (isBroadWritablePath(options.runDir, options.platform)) {
    throw new Error(`Refusing broad eval run directory: ${options.runDir}`);
  }
  const readOnlyPaths: string[] = [];
  for (const runtimePath of options.runtimeReadPaths) {
    if (isBroadRuntimePath(runtimePath, options.platform)) {
      throw new Error(`Refusing broad runtime read path: ${runtimePath}`);
    }
    if (isWithin(options.runDir, runtimePath)) continue;
    if (isWithin(runtimePath, options.runDir)) {
      throw new Error(
        `Runtime read path must not overlap the writable run directory: ${runtimePath}`,
      );
    }
    readOnlyPaths.push(runtimePath);
  }
  return {
    readOnlyPaths,
    writablePaths: [options.runDir],
    network: "proxy",
    proxyUrl: options.parentProxyUrl,
  };
}
