import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { EXTENSION_CACHE_ID, readCacheText } from "./pi-extension-cache-format.js";
import { currentProcessInstanceIdentities, processInstanceIdentities } from "./review/work-log.js";

const OWNER_FORMAT = /^(\d+):([0-9a-f]{32}):([0-9a-f]{64}(?:,[0-9a-f]{64}){0,4})\n$/;

export function isCacheError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function newCacheId(): string {
  return randomUUID().replaceAll("-", "");
}

export function cacheProcessOwner(platform: NodeJS.Platform, nonce: string): string {
  const identities = currentProcessInstanceIdentities(platform);
  if (identities === undefined) throw new Error("Could not identify extension cache owner");
  return `${process.pid}:${nonce}:${identities.join(",")}\n`;
}

export function cacheProcessExited(
  owner: string,
  platform: NodeJS.Platform,
  nonce?: string,
): boolean {
  const match = OWNER_FORMAT.exec(owner);
  if (!match || (nonce !== undefined && nonce !== match[2])) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isCacheError(error, "ESRCH")) return true;
    if (!isCacheError(error, "EPERM")) return false;
  }
  try {
    const active = processInstanceIdentities(pid, platform);
    const recorded = match[3]?.split(",") ?? [];
    return active !== undefined && !active.some((identity) => recorded.includes(identity));
  } catch {
    return false;
  }
}

export async function inspectPrivateCacheDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
    throw new Error("Unsafe extension cache directory");
}

async function dismissOwner(lock: string, nonce: string): Promise<void> {
  try {
    await unlink(path.join(lock, nonce));
  } catch (error) {
    if (!isCacheError(error, "ENOENT")) throw error;
  }
  try {
    await rmdir(lock);
  } catch (error) {
    if (!isCacheError(error, "ENOENT") && !isCacheError(error, "ENOTEMPTY")) throw error;
  }
}

/** Reclaims a dead owner without unlinking a lock installed by a concurrent contender. */
export async function reclaimExtensionCacheLock(
  lock: string,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await inspectPrivateCacheDirectory(lock);
    const entries = await readdir(lock);
    if (entries.length === 0) {
      // An empty lock has no owner. rmdir is atomic and fails once another owner appears.
      await rmdir(lock).catch((error: unknown) => {
        if (!isCacheError(error, "ENOTEMPTY")) throw error;
      });
      return;
    }
    const nonce = entries[0];
    if (entries.length !== 1 || nonce === undefined || !EXTENSION_CACHE_ID.test(nonce))
      throw new Error("Invalid extension cache lock owner");
    const owner = await readCacheText(path.join(lock, nonce), 1024);
    if (cacheProcessExited(owner, platform, nonce)) await dismissOwner(lock, nonce);
  } catch (error) {
    if (!isCacheError(error, "ENOENT")) throw error;
  }
}

export async function withNamedExtensionCacheLock<T>(
  lock: string,
  platform: NodeJS.Platform,
  waitMilliseconds: number,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const nonce = newCacheId();
  const owner = cacheProcessOwner(platform, nonce);
  const pending = `${lock}.pending-${nonce}`;
  await mkdir(pending, { mode: 0o700 });
  let acquired = false;
  try {
    await writeFile(path.join(pending, nonce), owner, { flag: "wx", mode: 0o600 });
    const deadline = performance.now() + waitMilliseconds;
    for (;;) {
      signal?.throwIfAborted();
      try {
        // A nonempty destination cannot be replaced. Empty directories can only be
        // left by an owner whose unique marker has already been removed.
        await rename(pending, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!isCacheError(error, "EEXIST") && !isCacheError(error, "ENOTEMPTY")) throw error;
      }
      await reclaimExtensionCacheLock(lock, platform);
      if (performance.now() >= deadline)
        throw new Error("Timed out waiting for extension cache lock");
      await setTimeout(25, undefined, { signal });
    }
    return await operation();
  } finally {
    if (acquired) await dismissOwner(lock, nonce);
    else await rm(pending, { recursive: true, force: true });
  }
}

export async function withExtensionCacheLock<T>(
  root: string,
  platform: NodeJS.Platform,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withNamedExtensionCacheLock(
    path.join(root, "cache.lock"),
    platform,
    3_000,
    operation,
    signal,
  );
}
