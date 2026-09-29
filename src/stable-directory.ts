import { lstat, mkdir, realpath } from "node:fs/promises";
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

/**
 * The same rules for a path Pioneer will create: the nearest existing folder is checked through
 * both its lexical and canonical chains before anything is created. A linked ancestor must itself
 * belong to the caller or root, since a sticky folder above it only protects the caller's own
 * entries; the folder holding the link and the link's target are then both checked.
 */
export async function assertStableProspectiveDirectory(
  target: string,
  platform: NodeJS.Platform,
  label: string,
  currentUid: number | undefined = process.getuid?.(),
): Promise<void> {
  if (platform === "win32") return;
  let existing = path.resolve(target);
  let stats: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    try {
      stats = await lstat(existing);
      break;
    } catch (error) {
      const parent = path.dirname(existing);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === existing) throw error;
      existing = parent;
    }
  }
  if (!stats.isSymbolicLink()) {
    await assertStableDirectoryChain(existing, platform, label);
    return;
  }
  if (currentUid === undefined || !isTrustedApplicationDataOwner(stats.uid, currentUid)) {
    throw new Error(`${label} has an untrusted owner: ${existing}`);
  }
  await assertStableDirectoryChain(path.dirname(existing), platform, label);
  await assertStableDirectoryChain(await realpath(existing), platform, label);
}

/**
 * Creates a directory for private output one folder at a time. The existing part of the path is
 * checked first; each missing folder is then created without recursion and inspected before the
 * next is created, so a link or foreign folder that appears after the check is refused instead
 * of followed. `beforeCreate` exists for tests that simulate that race.
 */
export async function createStableDirectory(
  directory: string,
  platform: NodeJS.Platform,
  label: string,
  currentUid: number | undefined = process.getuid?.(),
  hooks: { readonly beforeCreate?: (component: string) => Promise<void> } = {},
): Promise<void> {
  if (platform === "win32") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return;
  }
  await assertStableProspectiveDirectory(directory, platform, label, currentUid);
  const missing: string[] = [];
  for (let existing = path.resolve(directory); ; ) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      const parent = path.dirname(existing);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === existing) throw error;
      missing.unshift(existing);
      existing = parent;
    }
  }
  for (const component of missing) {
    await hooks.beforeCreate?.(component);
    try {
      await mkdir(component, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await lstat(component);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} is not a stable directory: ${component}`);
    }
    if (currentUid === undefined || !isTrustedApplicationDataOwner(stats.uid, currentUid)) {
      throw new Error(`${label} has an untrusted owner: ${component}`);
    }
    if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
      throw new Error(`${label} is writable by another user: ${component}`);
    }
  }
}
