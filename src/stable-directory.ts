import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Ownership and permission rules for a directory Pioneer will write private material into.
 *
 * A directory is only as trustworthy as every ancestor above it: a private child under a
 * non-sticky group- or world-writable parent can be renamed away and replaced by another local
 * user, who then receives whatever the controller writes next and whatever its cleanup removes.
 * The walk therefore covers the whole chain, following both the resolved and the canonical path
 * so a symlinked ancestor cannot hide a replaceable one.
 */
export function isTrustedStickyApplicationDataParent(
  parentUid: number,
  childUid: number,
  currentUid: number,
): boolean {
  return childUid === currentUid && isTrustedApplicationDataOwner(parentUid, currentUid);
}

export function isTrustedApplicationDataOwner(ownerUid: number, currentUid: number): boolean {
  return ownerUid === currentUid || ownerUid === 0;
}

export async function assertStableDirectoryChain(
  directory: string,
  platform: NodeJS.Platform,
  label: string,
): Promise<void> {
  if (platform === "win32") return;
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} is not a stable directory: ${directory}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error("Review application-data owner identity is unavailable");
  }
  if (!isTrustedApplicationDataOwner(stats.uid, currentUid)) {
    throw new Error(`${label} has an untrusted owner: ${directory}`);
  }
  if ((stats.mode & 0o022) !== 0) {
    const sticky = (stats.mode & 0o1000) !== 0;
    if (!sticky) {
      throw new Error(`${label} is writable by another user: ${directory}`);
    }
  }
  const roots = new Set([path.resolve(directory), await realpath(directory)]);
  for (const root of roots) {
    let child = root;
    let childStats = await lstat(child);
    for (;;) {
      const parent = path.dirname(child);
      if (parent === child) break;
      const parentStats = await lstat(parent);
      if (parentStats.isSymbolicLink()) {
        child = parent;
        childStats = parentStats;
        continue;
      }
      if (!parentStats.isDirectory()) {
        throw new Error(`${label} is not a stable directory: ${parent}`);
      }
      if (!isTrustedApplicationDataOwner(parentStats.uid, currentUid)) {
        throw new Error(`${label} has an untrusted owner: ${parent}`);
      }
      if ((parentStats.mode & 0o022) !== 0) {
        const sticky = (parentStats.mode & 0o1000) !== 0;
        if (
          !sticky ||
          !isTrustedStickyApplicationDataParent(parentStats.uid, childStats.uid, currentUid)
        ) {
          throw new Error(`${label} is writable by another user: ${parent}`);
        }
      }
      child = parent;
      childStats = parentStats;
    }
  }
}
