import { lstat, readdir, realpath } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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

export interface EvalSandboxConfigOptions {
  readonly platform: EvalPlatform;
  readonly runDir: string;
  readonly runtimeReadPaths: readonly string[];
  readonly parentProxyUrl: string;
}

const BROAD_POSIX_PATHS = new Set(["/", "/Users", "/home", "/private", "/tmp", "/var"]);

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

function isBroadRuntimePath(candidate: string): boolean {
  if (process.platform === "win32") {
    const parsed = path.win32.parse(candidate);
    return candidate.toLowerCase() === parsed.root.toLowerCase();
  }
  return BROAD_POSIX_PATHS.has(candidate) || candidate === os.homedir();
}

export async function validateEvalRunSpec(spec: EvalRunSpec): Promise<ValidatedEvalRunSpec> {
  if (spec.command.length === 0 || spec.command.some((argument) => argument.includes("\0"))) {
    throw new Error("Eval command must contain non-NUL argv entries");
  }
  const runDir = await realpath(spec.runDir);
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
  const allowRead = [options.runDir, ...options.runtimeReadPaths];
  return {
    readOnlyPaths: allowRead.filter((entry) => entry !== options.runDir),
    writablePaths: [options.runDir],
    network: "proxy",
    proxyUrl: options.parentProxyUrl,
  };
}
