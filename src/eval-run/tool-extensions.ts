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
  const snapshot = await snapshotExtensionResources(
    resources,
    destination,
    signal,
    storage,
    budget,
    excludedPaths,
  );
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
