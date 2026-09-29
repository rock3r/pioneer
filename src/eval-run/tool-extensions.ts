import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { diagnosticMessage } from "../diagnostics.js";
import {
  type ExtensionResource,
  mirroredExtensionStagePath,
  snapshotExtensionResources,
} from "../pi-extension-snapshot.js";
import type { PiRuntimeStorage } from "../pi-runtime-storage.js";
import { isWithin } from "./isolation.js";

export interface ToolExtensionSource {
  readonly canonical: string;
  readonly kind: "file" | "directory";
  /** Canonical entry points Pi will load, all inside `canonical`. */
  readonly entries: readonly string[];
}

export interface StagedToolExtensions {
  /** Staged paths passed to Pi with `--extension` and trusted to keep their tools. */
  readonly paths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly entries: number;
  readonly bytes: number;
}

function invalidToolSource(message: string): Error {
  return new Error(diagnosticMessage("PI_EXTENSION_TOOL_SOURCE_INVALID", message));
}

async function existingEntry(candidate: string, root: string): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    return undefined;
  }
  if (!isWithin(root, canonical)) {
    throw invalidToolSource(
      "--pi-extension package names an entry outside its directory; stage a self-contained package",
    );
  }
  return canonical;
}

/** Mirrors Pi's own directory resolution: a `pi.extensions` manifest, then index.ts/js. */
async function packageEntries(dir: string): Promise<string[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      (await readFile(path.join(dir, "package.json"), "utf8")).replace(/^﻿/, ""),
    );
  } catch {
    manifest = undefined;
  }
  const declared =
    typeof manifest === "object" &&
    manifest !== null &&
    "pi" in manifest &&
    typeof manifest.pi === "object" &&
    manifest.pi !== null &&
    "extensions" in manifest.pi &&
    Array.isArray(manifest.pi.extensions) &&
    manifest.pi.extensions.every((entry: unknown) => typeof entry === "string")
      ? (manifest.pi.extensions as string[])
      : [];
  const entries: string[] = [];
  for (const entry of declared) {
    const resolved = await existingEntry(path.resolve(dir, entry), dir);
    if (resolved !== undefined) entries.push(resolved);
  }
  if (entries.length > 0) return entries;
  for (const name of ["index.ts", "index.js"]) {
    const resolved = await existingEntry(path.join(dir, name), dir);
    if (resolved !== undefined) return [resolved];
  }
  return [];
}

export async function resolveToolExtensionSource(source: string): Promise<ToolExtensionSource> {
  let canonical: string;
  try {
    canonical = await realpath(source);
  } catch {
    throw invalidToolSource("--pi-extension path was not found");
  }
  const details = await lstat(canonical);
  if (details.isFile()) return { canonical, kind: "file", entries: [canonical] };
  if (!details.isDirectory()) {
    throw invalidToolSource("--pi-extension must name an extension file or package directory");
  }
  const entries = await packageEntries(canonical);
  if (entries.length === 0) {
    throw invalidToolSource(
      "--pi-extension directory has no extension entry: add a package.json pi.extensions list or an index.ts/index.js",
    );
  }
  return { canonical, kind: "directory", entries };
}

/** Few adapters are ever needed; the bound keeps resolution and the actor argv small. */
export const MAX_TOOL_EXTENSIONS = 8;

export function assertToolExtensionCount(paths: readonly string[]): void {
  if (paths.length > MAX_TOOL_EXTENSIONS) {
    throw invalidToolSource(`--pi-extension accepts at most ${MAX_TOOL_EXTENSIONS} extensions`);
  }
}

/** Each tool extension must load once; a repeat or nested source would register it twice. */
export function assertDistinctToolExtensionSources(sources: readonly ToolExtensionSource[]): void {
  sources.forEach((source, index) => {
    const overlaps = sources.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        (isWithin(other.canonical, source.canonical) ||
          isWithin(source.canonical, other.canonical)),
    );
    if (overlaps) {
      throw invalidToolSource(
        "--pi-extension names the same extension more than once, directly or inside another --pi-extension directory",
      );
    }
  });
}

/**
 * Copies `--pi-extension` sources into a read-only snapshot like any explicit extension.
 * A package directory is staged whole, with its ancestor `node_modules`, and Pi resolves
 * its entries from the staged copy. The snapshot applies the usual location policy.
 */
export async function stageToolExtensions(
  sources: readonly ToolExtensionSource[],
  destination: string,
  storage: PiRuntimeStorage,
  signal: AbortSignal | undefined,
  budget: { readonly entries: number; readonly bytes: number },
  excludedPaths: readonly string[],
  /** The part of `budget` used by enabled user extensions; the rest is explicit `-e` code. */
  userExtensions: { readonly entries: number; readonly bytes: number } = { entries: 0, bytes: 0 },
): Promise<StagedToolExtensions> {
  if (sources.length === 0) return { paths: [], sourcePaths: [], ...budget };
  const resources: ExtensionResource[] = sources.flatMap((source) =>
    source.entries.map((entry) => ({
      path: entry,
      enabled: true,
      metadata:
        source.kind === "directory"
          ? { scope: "user", origin: "package", baseDir: source.canonical }
          : { scope: "user" },
    })),
  );
  let snapshot: Awaited<ReturnType<typeof snapshotExtensionResources>>;
  try {
    snapshot = await snapshotExtensionResources(
      resources,
      destination,
      signal,
      storage,
      budget,
      excludedPaths,
    );
  } catch (error) {
    // The budget carries the user and explicit extensions staged before these tool sources.
    if (!(error instanceof Error) || !error.message.startsWith("[PI_EXTENSION_SNAPSHOT_LIMIT]")) {
      throw error;
    }
    const share = (used: { readonly entries: number; readonly bytes: number }): string =>
      `${(used.bytes / 1024 ** 2).toFixed(1)} MiB in ${used.entries} entries`;
    if (userExtensions.entries > 0 || userExtensions.bytes > 0) {
      throw new Error(
        `${error.message} The limit is shared with ${share(userExtensions)} of enabled user extensions; pass --no-extensions on the Pi command when this eval does not need them.`,
      );
    }
    if (budget.entries > 0 || budget.bytes > 0) {
      throw new Error(
        `${error.message} The limit is shared with ${share(budget)} of explicit Pi extensions; drop or trim the -e extensions.`,
      );
    }
    throw error;
  }
  const paths: string[] = [];
  for (const source of sources) {
    const staged = mirroredExtensionStagePath(destination, source.canonical);
    const details = await lstat(staged).catch(() => undefined);
    if (
      details === undefined ||
      (source.kind === "file" ? !details.isFile() : !details.isDirectory())
    ) {
      throw new Error("[PI_EXTENSION_TOOL_SOURCE_INVALID] --pi-extension was not staged");
    }
    paths.push(staged);
  }
  return {
    paths,
    sourcePaths: sources.map((source) => source.canonical),
    entries: snapshot.entries,
    bytes: snapshot.bytes,
  };
}
