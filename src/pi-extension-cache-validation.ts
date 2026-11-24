import { type BigIntStats, constants } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import path from "node:path";
import {
  cacheRelativePathForSource,
  EXTENSION_CACHE_PACKAGE_JSON,
} from "./pi-extension-cache-format.js";
import {
  type ExtensionManifestRecord,
  type ExtensionSnapshotPlan,
  mirroredExtensionStagePath,
  SNAPSHOT_ENTRY_LIMIT,
  validateCachedExtensionRunPolicy,
} from "./pi-extension-snapshot.js";
import { type WalkLevel, walkBounded } from "./pi-extension-snapshot-walk.js";

class ManifestMismatch extends Error {}

type CopyMetadata = Extract<ExtensionManifestRecord, { readonly staged: true }>["stagedMetadata"];

function matchesCopy(details: BigIntStats, entry: CopyMetadata): boolean {
  return (
    details.ino === entry.ino &&
    details.size === entry.size &&
    details.mode === entry.mode &&
    details.mtimeNs === entry.mtimeNs &&
    details.ctimeNs === entry.ctimeNs
  );
}

async function walkSource(
  roots: readonly string[],
  manifest: ReadonlyMap<string, ExtensionManifestRecord>,
  signal?: AbortSignal,
): Promise<void> {
  let queued = roots.length;
  if (queued > manifest.size) throw new ManifestMismatch();
  await walkBounded(
    { size: roots.length, next: 0, child: (index) => roots[index] ?? "" },
    async (source): Promise<WalkLevel<string> | undefined> => {
      const record = manifest.get(source);
      if (record === undefined) throw new ManifestMismatch();
      const actual = await lstat(source, { bigint: true });
      if (
        !matchesCopy(actual, record.source) ||
        actual.dev !== record.source.dev ||
        actual.nlink !== record.source.nlink
      ) {
        throw new ManifestMismatch();
      }
      if (actual.isSymbolicLink()) {
        if (record.type !== "symlink" || (await readlink(source)) !== record.linkText)
          throw new ManifestMismatch();
        return undefined;
      }
      const type = actual.isDirectory() ? "directory" : actual.isFile() ? "file" : "other";
      if (record.type !== type) throw new ManifestMismatch();
      if (type !== "directory") return undefined;
      // Read directory membership even when timestamps match. Enumerate lazily so new names
      // cannot allocate more space than the validated manifest/prepass limit.
      const names: string[] = [];
      const directory = await opendir(source, { bufferSize: 128 });
      for await (const child of directory) {
        signal?.throwIfAborted();
        queued += 1;
        if (queued > manifest.size) throw new ManifestMismatch();
        names.push(child.name);
      }
      return {
        size: names.length,
        next: 0,
        // Names are single path components and the canonical root has no trailing slash.
        child: (index) => `${source}${path.sep}${names[index] ?? ""}`,
      };
    },
    signal,
  );
  if (queued !== manifest.size) throw new ManifestMismatch();
}

/** Check the generated ancestors as well as the selected roots and their recorded entries. */
async function validatePayloadDirectories(
  payload: string,
  roots: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const directories = new Map([[payload, new Set(["package.json"])]]);
  for (const root of roots) {
    let child = mirroredExtensionStagePath(payload, root);
    for (;;) {
      const parent = path.dirname(child);
      const existing = directories.get(parent);
      if (existing !== undefined) {
        existing.add(path.basename(child));
        break;
      }
      directories.set(parent, new Set([path.basename(child)]));
      child = parent;
    }
  }
  for (const dir of [...directories.keys()].sort((a, b) => a.length - b.length)) {
    signal?.throwIfAborted();
    const details = await lstat(dir);
    if (!details.isDirectory() || (details.mode & 0o777) !== 0o700) throw new ManifestMismatch();
    const expected = directories.get(dir);
    const children = await opendir(dir);
    for await (const child of children) {
      if (!expected?.delete(child.name)) throw new ManifestMismatch();
    }
    if (expected?.size !== 0) throw new ManifestMismatch();
  }
}

const PACKAGE_BYTES = Buffer.from(EXTENSION_CACHE_PACKAGE_JSON);

async function hasPackageScope(payload: string): Promise<boolean> {
  const handle = await open(
    path.join(payload, "package.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o400 ||
      details.size !== PACKAGE_BYTES.length
    ) {
      return false;
    }
    const actual = Buffer.alloc(PACKAGE_BYTES.length + 1);
    const { bytesRead } = await handle.read(actual, 0, actual.length, 0);
    return (
      bytesRead === PACKAGE_BYTES.length && actual.subarray(0, bytesRead).equals(PACKAGE_BYTES)
    );
  } finally {
    await handle.close();
  }
}

export async function validateCachedExtensionSnapshot(
  plan: ExtensionSnapshotPlan,
  payload: string,
  manifest: readonly ExtensionManifestRecord[],
  signal?: AbortSignal,
): Promise<"valid" | "source-mismatch" | "copy-mismatch" | "run-exclusions"> {
  signal?.throwIfAborted();
  if (manifest.length > SNAPSHOT_ENTRY_LIMIT) return "copy-mismatch";
  const sourceManifest = new Map<string, ExtensionManifestRecord>();
  for (const record of manifest) sourceManifest.set(record.sourcePath, record);
  if (sourceManifest.size !== manifest.length) return "copy-mismatch";
  try {
    await walkSource(plan.selectedRoots, sourceManifest, signal);
  } catch {
    signal?.throwIfAborted();
    return "source-mismatch";
  }
  try {
    await validatePayloadDirectories(payload, plan.selectedRoots, signal);
    if (!(await hasPackageScope(payload))) return "copy-mismatch";
    await walkBounded(
      { size: manifest.length, next: 0, child: (index) => index },
      async (index) => {
        const record = manifest[index];
        if (!record?.staged) return undefined;
        if (
          record.stagedRelativePath !== cacheRelativePathForSource(record.sourcePath) ||
          !matchesCopy(
            await lstat(`${payload}${path.sep}${record.stagedRelativePath}`, { bigint: true }),
            record.stagedMetadata,
          )
        )
          throw new ManifestMismatch();
        return undefined;
      },
      signal,
    );
  } catch {
    signal?.throwIfAborted();
    return "copy-mismatch";
  }
  return validateCachedExtensionRunPolicy(plan, payload, sourceManifest, manifest, signal);
}
