import { lstat, mkdir, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCacheEntry } from "./pi-extension-cache.js";
import {
  EXTENSION_CACHE_ID,
  EXTENSION_CACHE_KEY,
  extensionCacheApparentSize,
  openPrivateCacheFile,
  readCacheText,
} from "./pi-extension-cache-format.js";
import {
  cacheProcessExited,
  cacheProcessOwner,
  inspectPrivateCacheDirectory,
  isCacheError,
  newCacheId,
  reclaimExtensionCacheLock,
  withExtensionCacheLock,
} from "./pi-extension-cache-lock.js";

const MAX_APPARENT_BYTES = 3 * 1024 ** 3;
const MAX_UNUSED_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ABANDONED_STAGING_AGE_MS = 60 * 60 * 1000;

interface Candidate {
  readonly key: string;
  readonly id: string;
  readonly directory: string;
  readonly bytes: number;
  readonly created: bigint;
  readonly usedAt: number;
  readonly bad: boolean;
}

interface CollectionOptions {
  readonly now?: number;
  readonly maxBytes?: number;
}

function leasesDirectory(root: string, generation: string): string {
  return path.join(root, "leases", generation);
}

async function removeIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: unknown) => {
    if (!isCacheError(error, "ENOENT")) throw error;
  });
}

/** Called under cache.lock before reading snapshot data. */
export async function takeExtensionCacheLease(
  entry: ExtensionCacheEntry,
  platform: NodeJS.Platform,
  now: () => number,
): Promise<() => Promise<void>> {
  await inspectPrivateCacheDirectory(entry.directory);
  const nonce = newCacheId();
  const owner = cacheProcessOwner(platform, nonce);
  const directory = leasesDirectory(entry.root, entry.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectPrivateCacheDirectory(directory);
  const pending = path.join(directory, `pending-${nonce}`);
  const filename = path.join(directory, `${nonce}.json`);
  const lastUsed = await openPrivateCacheFile(path.join(entry.directory, "last-used"));
  try {
    const timestamp = new Date(now());
    await lastUsed.utimes(timestamp, timestamp);
  } finally {
    await lastUsed.close();
  }
  try {
    await writeFile(pending, `${JSON.stringify({ owner })}\n`, { flag: "wx", mode: 0o600 });
    await rename(pending, filename);
  } finally {
    await removeIfPresent(pending);
  }
  let released: Promise<void> | undefined;
  return () =>
    (released ??= withExtensionCacheLock(entry.root, platform, async () => {
      await removeIfPresent(filename);
    })
      .then(() => collectExtensionCache(entry.root, platform, { now: now() }))
      .catch(() => undefined));
}

async function readCandidate(
  root: string,
  key: string,
  id: string,
): Promise<Candidate | undefined> {
  const directory = path.join(root, "entries", key, id);
  try {
    await inspectPrivateCacheDirectory(directory);
  } catch {
    return undefined;
  }
  const snapshot = path.join(directory, "snapshot.json");
  try {
    const [payloadBytes, created, lastUsed, bad, manifest, packageScope, boot] = await Promise.all([
      readCacheText(snapshot).then(extensionCacheApparentSize),
      lstat(snapshot, { bigint: true }),
      lstat(path.join(directory, "last-used")),
      lstat(path.join(directory, "bad")).then(
        () => true,
        (error: unknown) => {
          if (isCacheError(error, "ENOENT")) return false;
          throw error;
        },
      ),
      lstat(path.join(directory, "manifest.jsonl")),
      lstat(path.join(directory, "payload", "package.json")),
      lstat(path.join(directory, "verified-boot")),
    ]);
    const bytes =
      payloadBytes +
      Number(created.size) +
      manifest.size +
      packageScope.size +
      boot.size +
      lastUsed.size;
    return { key, id, directory, bytes, created: created.mtimeNs, usedAt: lastUsed.mtimeMs, bad };
  } catch {
    return { key, id, directory, bytes: 0, created: 0n, usedAt: 0, bad: true };
  }
}

async function readCandidates(root: string): Promise<Candidate[]> {
  const entries = path.join(root, "entries");
  const candidates: Candidate[] = [];
  for (const key of await readdir(entries)) {
    if (!EXTENSION_CACHE_KEY.test(key)) continue;
    const directory = path.join(entries, key);
    try {
      await inspectPrivateCacheDirectory(directory);
    } catch {
      continue;
    }
    for (const id of await readdir(directory)) {
      if (!EXTENSION_CACHE_ID.test(id)) continue;
      const entry = await readCandidate(root, key, id);
      if (entry !== undefined) candidates.push(entry);
    }
  }
  return candidates;
}

async function hasLiveLease(
  root: string,
  platform: NodeJS.Platform,
  generation: string,
): Promise<boolean> {
  const directory = leasesDirectory(root, generation);
  try {
    await inspectPrivateCacheDirectory(directory);
  } catch (error) {
    return !isCacheError(error, "ENOENT");
  }
  try {
    let live = false;
    for (const name of await readdir(directory)) {
      const nonce = name.slice(0, -5);
      if (!name.endsWith(".json") || !EXTENSION_CACHE_ID.test(nonce)) continue;
      const file = path.join(directory, name);
      const lease: unknown = JSON.parse(await readCacheText(file, 1024));
      const owner =
        typeof lease === "object" && lease !== null && "owner" in lease ? lease.owner : undefined;
      if (typeof owner === "string" && cacheProcessExited(owner, platform, nonce))
        await removeIfPresent(file);
      else live = true;
    }
    return live;
  } catch {
    // An unreadable lease or lease directory has an unknown owner. Keep it.
    return true;
  }
}

async function moveToTrash(root: string, directory: string): Promise<void> {
  await rename(directory, path.join(root, "trash", newCacheId()));
}

export async function collectExtensionCache(
  root: string,
  platform: NodeJS.Platform,
  options: CollectionOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const budget = options.maxBytes ?? MAX_APPARENT_BYTES;
  await withExtensionCacheLock(root, platform, async () => {
    const candidates = await readCandidates(root);
    const newest = new Map<string, bigint>();
    let remaining = 0;
    for (const candidate of candidates) {
      remaining += candidate.bytes;
      const current = newest.get(candidate.key);
      if (!candidate.bad && (current === undefined || candidate.created > current))
        newest.set(candidate.key, candidate.created);
    }
    const expired = (candidate: Candidate) =>
      candidate.bad ||
      now - candidate.usedAt > MAX_UNUSED_AGE_MS ||
      candidate.created < (newest.get(candidate.key) ?? candidate.created);
    const candidatesByAge = candidates.sort(
      (left, right) => Number(expired(right)) - Number(expired(left)) || left.usedAt - right.usedAt,
    );
    for (const candidate of candidatesByAge) {
      if (await hasLiveLease(root, platform, candidate.id)) continue;
      if (!expired(candidate) && remaining <= budget) continue;
      await moveToTrash(root, candidate.directory);
      await rm(leasesDirectory(root, candidate.id), { recursive: true, force: true });
      remaining -= candidate.bytes;
    }
  });
}

async function reclaimStaging(root: string, platform: NodeJS.Platform, now: number): Promise<void> {
  const staging = path.join(root, "staging");
  for (const nonce of await readdir(staging)) {
    if (!EXTENSION_CACHE_ID.test(nonce)) continue;
    const directory = path.join(staging, nonce);
    try {
      await inspectPrivateCacheDirectory(directory);
      if (now - (await lstat(directory)).mtimeMs <= ABANDONED_STAGING_AGE_MS) continue;
      const owner = await readCacheText(path.join(directory, "owner"), 1024).catch(
        (error: unknown) => {
          if (isCacheError(error, "ENOENT")) return undefined;
          throw error;
        },
      );
      if (owner === undefined || cacheProcessExited(owner, platform, nonce))
        await moveToTrash(root, directory);
    } catch {
      // Another run may have committed its stage. Unreadable state is left in place.
    }
  }
}

async function reclaimCreationLocks(
  root: string,
  platform: NodeJS.Platform,
  now: number,
): Promise<void> {
  const entries = path.join(root, "entries");
  for (const [parent, pattern] of [
    [entries, /^[0-9a-f]{64}\.creating(?:\.pending-[0-9a-f]{32})?$/],
    [root, /^cache\.lock\.pending-[0-9a-f]{32}$/],
  ] as const) {
    for (const name of await readdir(parent)) {
      if (!pattern.test(name)) continue;
      const directory = path.join(parent, name);
      try {
        if (
          name.includes(".pending-") &&
          now - (await lstat(directory)).mtimeMs <= ABANDONED_STAGING_AGE_MS
        )
          continue;
        await reclaimExtensionCacheLock(directory, platform);
      } catch {
        // One unavailable lock cannot prevent collection of other cache entries.
      }
    }
  }
}

interface BackgroundDeletion {
  readonly started: Promise<void>;
  readonly finished: Promise<void>;
}

const backgroundDeletions = new Map<string, BackgroundDeletion>();

/** Starts draining existing trash. No new evictions are deleted on the release path. */
export function startExtensionCacheBackgroundDeletion(
  root: string,
  platform: NodeJS.Platform,
  now = Date.now(),
): BackgroundDeletion {
  const current = backgroundDeletions.get(root);
  if (current !== undefined) return current;
  const trash = path.join(root, "trash");
  const previous = withExtensionCacheLock(root, platform, async () => {
    await reclaimStaging(root, platform, now);
    await reclaimCreationLocks(root, platform, now);
    return readdir(trash);
  }).catch(() => []);
  const finished = previous
    .then(async (names) => {
      for (const name of names) {
        if (EXTENSION_CACHE_ID.test(name))
          await rm(path.join(trash, name), { recursive: true, force: true }).catch(() => undefined);
      }
    })
    .finally(() => {
      backgroundDeletions.delete(root);
    });
  const deletion = { started: previous.then(() => undefined), finished };
  backgroundDeletions.set(root, deletion);
  return deletion;
}
