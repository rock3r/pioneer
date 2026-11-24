import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ExtensionManifestRecord, ExtensionSnapshot } from "./pi-extension-snapshot.js";

export const EXTENSION_CACHE_PACKAGE_JSON = '{"type":"module"}';
export const EXTENSION_CACHE_FORMAT = 1;
export const EXTENSION_CACHE_ID = /^[0-9a-f]{32}$/;
export const EXTENSION_CACHE_KEY = /^[0-9a-f]{64}$/;

const MAX_ENTRIES = 500_000;
const MAX_BYTES = 1024 ** 3;
const MAX_MANIFEST_LINE_BYTES = 64 * 1024;
// Pi's resource resolution has a 1 MiB output ceiling. Absolute and relative copies of
// canonical entry paths can be longer, but still need a finite snapshot metadata budget.
const MAX_SNAPSHOT_METADATA_BYTES = 16 * 1024 * 1024;
const NONCANONICAL_PATH_COMPONENT = /\0|\/\/|\/\.{1,2}(?:\/|$)/;
const DECIMAL_INTEGER = /^-?(?:0|[1-9][0-9]{0,19})$/;

function invalidMetadata(): Error {
  return new Error("Invalid cache snapshot metadata");
}

type CacheMetadata = Record<string, unknown>;

function metadata(value: unknown): CacheMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidMetadata();
  return value as CacheMetadata;
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !NONCANONICAL_PATH_COMPONENT.test(value) &&
    (value.length === 1 || !value.endsWith("/"))
  );
}

/** The native cache mirrors canonical POSIX paths under the encoded filesystem root. */
export function cacheRelativePathForSource(canonicalSource: string): string {
  return `tree/%2F${canonicalSource}`;
}

function metadataInteger(value: unknown, signed = false): bigint {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value) || (!signed && value[0] === "-"))
    throw invalidMetadata();
  return BigInt(value);
}

function stagedMetadata(object: CacheMetadata) {
  return {
    ino: metadataInteger(object.ino),
    size: metadataInteger(object.size),
    mode: metadataInteger(object.mode),
    mtimeNs: metadataInteger(object.mtimeNs, true),
    ctimeNs: metadataInteger(object.ctimeNs, true),
  };
}

function manifestRecord(value: unknown): ExtensionManifestRecord {
  const record = metadata(value);
  const { sourcePath, type, linkText, skippedLinkTarget } = record;
  if (
    !absolutePath(sourcePath) ||
    (type !== "file" && type !== "directory" && type !== "symlink" && type !== "other") ||
    (type === "symlink"
      ? typeof linkText !== "string" || linkText.length === 0 || linkText.includes("\0")
      : linkText !== undefined) ||
    (skippedLinkTarget !== undefined &&
      (type !== "symlink" || record.staged !== false || !absolutePath(skippedLinkTarget)))
  )
    throw invalidMetadata();
  const source = metadata(record.source);
  const entry = {
    sourcePath,
    type,
    source: {
      ...stagedMetadata(source),
      dev: metadataInteger(source.dev),
      nlink: metadataInteger(source.nlink),
    },
    ...(typeof linkText === "string" ? { linkText } : {}),
  } as const;
  if (
    record.staged === false &&
    record.stagedRelativePath === undefined &&
    record.stagedMetadata === undefined
  )
    return {
      ...entry,
      staged: false,
      ...(skippedLinkTarget === undefined ? {} : { skippedLinkTarget }),
    };
  if (
    record.staged !== true ||
    type === "other" ||
    record.stagedRelativePath !== cacheRelativePathForSource(sourcePath)
  )
    throw invalidMetadata();
  return {
    ...entry,
    staged: true,
    stagedRelativePath: record.stagedRelativePath,
    stagedMetadata: stagedMetadata(metadata(record.stagedMetadata)),
  };
}

async function openCacheFile(file: string): Promise<FileHandle> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o077) !== 0
    )
      throw invalidMetadata();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readCacheText(
  file: string,
  maxBytes = MAX_SNAPSHOT_METADATA_BYTES,
): Promise<string> {
  const handle = await openCacheFile(file);
  try {
    if ((await handle.stat()).size > maxBytes) throw invalidMetadata();
    const value = await handle.readFile("utf8");
    if (Buffer.byteLength(value) > maxBytes) throw invalidMetadata();
    return value;
  } finally {
    await handle.close();
  }
}

export async function readExtensionCacheManifest(
  file: string,
  signal?: AbortSignal,
): Promise<readonly ExtensionManifestRecord[]> {
  const handle = await openCacheFile(file);
  const records: ExtensionManifestRecord[] = [];
  const seen = new Set<string>();
  const stream = handle.createReadStream({ encoding: "utf8", highWaterMark: 256 * 1024 });
  let remainder = "";
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const lines = (remainder + (chunk as string)).split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (
        records.length === MAX_ENTRIES ||
        (line.length * 3 > MAX_MANIFEST_LINE_BYTES &&
          Buffer.byteLength(line) > MAX_MANIFEST_LINE_BYTES)
      )
        throw invalidMetadata();
      const record = manifestRecord(JSON.parse(line));
      if (seen.has(record.sourcePath)) throw invalidMetadata();
      seen.add(record.sourcePath);
      records.push(record);
    }
    if (Buffer.byteLength(remainder) > MAX_MANIFEST_LINE_BYTES) throw invalidMetadata();
  }
  if (remainder.length !== 0) throw invalidMetadata();
  return records;
}

export async function writeExtensionCacheManifest(
  file: string,
  manifest: readonly ExtensionManifestRecord[],
): Promise<void> {
  function* records(): Iterable<string> {
    for (const record of manifest) {
      yield `${JSON.stringify(record, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`;
    }
  }
  const handle = await open(file, "wx", 0o600);
  await pipeline(records(), handle.createWriteStream());
}

interface CacheSnapshotMetadata extends ExtensionSnapshot {
  readonly createdAt: number;
}

function boundedInteger(input: unknown, min: number, max: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= min && input <= max;
}

export function extensionCacheSnapshotMetadata(
  text: string,
  manifest: readonly ExtensionManifestRecord[],
  payload: string,
): CacheSnapshotMetadata {
  if (!text.endsWith("\n")) throw invalidMetadata();
  const { paths, sourcePaths, digest, entries, bytes, createdAt } = metadata(JSON.parse(text));
  if (
    !Array.isArray(paths) ||
    !Array.isArray(sourcePaths) ||
    paths.length !== sourcePaths.length ||
    typeof digest !== "string" ||
    !EXTENSION_CACHE_KEY.test(digest) ||
    !boundedInteger(entries, 0, MAX_ENTRIES) ||
    !boundedInteger(bytes, 0, MAX_BYTES) ||
    !boundedInteger(createdAt, 0, Number.MAX_SAFE_INTEGER)
  )
    throw invalidMetadata();
  const expected = new Map<string, string>();
  const actualPaths: string[] = [];
  const actualSources: string[] = [];
  for (const [index, source] of sourcePaths.entries()) {
    if (!absolutePath(source) || expected.has(source)) throw invalidMetadata();
    const relative = cacheRelativePathForSource(source);
    if (paths[index] !== relative) throw invalidMetadata();
    expected.set(source, relative);
    actualPaths.push(path.join(payload, relative));
    actualSources.push(source);
  }
  let totalEntries = 0;
  let totalBytes = 0n;
  for (const record of manifest) {
    if (!record.staged) continue;
    totalEntries += 1;
    if (record.type === "file") totalBytes += record.source.size;
    if (expected.get(record.sourcePath) === record.stagedRelativePath)
      expected.delete(record.sourcePath);
  }
  if (expected.size !== 0 || totalEntries !== entries || totalBytes !== BigInt(bytes))
    throw invalidMetadata();
  return { paths: actualPaths, sourcePaths: actualSources, digest, entries, bytes, createdAt };
}
