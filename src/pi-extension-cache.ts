import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PIONEER_VERSION } from "./package-metadata.js";
import {
  EXTENSION_CACHE_FORMAT,
  EXTENSION_CACHE_ID,
  EXTENSION_CACHE_PACKAGE_JSON,
  extensionCacheSnapshotMetadata,
  readCacheText,
  readExtensionCacheManifest,
  writeExtensionCacheManifest,
} from "./pi-extension-cache-format.js";
import {
  assertExtensionCacheDisjointFromGrants,
  extensionCacheRoot,
} from "./pi-extension-cache-location.js";
import {
  cacheProcessOwner,
  inspectPrivateCacheDirectory,
  isCacheError,
  newCacheId,
  withExtensionCacheLock,
  withNamedExtensionCacheLock,
} from "./pi-extension-cache-lock.js";
import {
  type ExtensionManifestRecord,
  type ExtensionSnapshot,
  type ExtensionSnapshotPlan,
  recomputeExtensionSnapshotDigest,
  stageExtensionSnapshot,
  validateExtensionSnapshot,
} from "./pi-extension-snapshot.js";
import { createStableDirectory } from "./stable-directory.js";

const RACY_MARGIN_NS = 2_000_000_000n;
const CREATE_WAIT_MS = 120_000;
const execute = promisify(execFile);

export interface ExtensionCacheEntry {
  readonly root: string;
  readonly key: string;
  readonly id: string;
  readonly directory: string;
  readonly payload: string;
}

export interface ExtensionCacheGeneration extends ExtensionCacheEntry {
  readonly snapshot: ExtensionSnapshot;
  readonly manifest: readonly ExtensionManifestRecord[];
  readonly createdAt: number;
}

export interface ExtensionSnapshotHandle {
  /** The only cache directory that may appear in an actor grant. */
  readonly payload: string;
  readonly cacheRoot: string;
  release(): Promise<void>;
}

export interface CachedExtensionSnapshot extends ExtensionSnapshot {
  readonly snapshotHandle?: ExtensionSnapshotHandle;
}

export interface ExtensionSnapshotCacheEvent {
  readonly cache: "hit" | "miss" | "bypass" | "racy";
  readonly reason:
    | "validated"
    | "staged"
    | "disabled"
    | "unsupported-platform"
    | "empty"
    | "unsafe-cache"
    | "cache-unavailable"
    | "run-exclusions"
    | "recent-source";
}

type Validate = (
  plan: ExtensionSnapshotPlan,
  payload: string,
  manifest: readonly ExtensionManifestRecord[],
  signal?: AbortSignal,
) => Promise<"valid" | "source-mismatch" | "copy-mismatch" | "run-exclusions">;

type Release = () => Promise<void>;

export interface ExtensionCacheOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly cacheRoot?: string;
  readonly signal?: AbortSignal;
  readonly record?: (event: ExtensionSnapshotCacheEvent) => void;
  readonly now?: () => number;
  readonly readBootId?: () => Promise<string | undefined>;
  readonly validate?: Validate;
  /** Runs under cache.lock. The release function must acquire its own lock if needed. */
  readonly takeLease?: (entry: ExtensionCacheEntry) => Promise<Release>;
}

interface ActiveCache {
  readonly root: string;
  readonly key: string;
  readonly platform: NodeJS.Platform;
  readonly bootId: string | undefined;
  readonly now: () => number;
  readonly signal: AbortSignal | undefined;
  readonly validate: Validate;
  readonly takeLease: (entry: ExtensionCacheEntry) => Promise<Release>;
}

export function extensionCacheKey(
  plan: ExtensionSnapshotPlan,
  platform: NodeJS.Platform,
  uid: number,
  version = PIONEER_VERSION,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        EXTENSION_CACHE_FORMAT,
        version,
        platform,
        uid,
        plan.enabled.map(({ path: resource, metadata }) => [
          resource,
          metadata.origin,
          metadata.baseDir,
        ]),
        plan.selectedRoots,
        plan.agentDir,
        [...new Set(plan.privateDirectories)].sort(),
        plan.credentialPathRoots,
      ]),
    )
    .digest("hex");
}

async function createPrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isCacheError(error, "EEXIST")) throw error;
  }
  await inspectPrivateCacheDirectory(directory);
}

async function initializeRoot(root: string, platform: NodeJS.Platform): Promise<string> {
  const snapshots = path.dirname(root);
  const directories =
    path.basename(snapshots) === "extension-snapshots" ? [snapshots, root] : [root];
  // The cache parent may have ordinary application-data permissions. Everything Pioneer
  // uses below it must be a private directory owned by this controller's user.
  await createStableDirectory(
    path.dirname(directories[0] ?? root),
    platform,
    "Extension cache parent",
  );
  for (const directory of directories) await createPrivateDirectory(directory);
  const canonical = await realpath(root);
  for (const name of ["entries", "leases", "staging", "trash"])
    await createPrivateDirectory(path.join(canonical, name));
  return canonical;
}

const platformBootIds = new Map<NodeJS.Platform, Promise<string | undefined>>();

async function readPlatformBootId(platform: NodeJS.Platform): Promise<string | undefined> {
  try {
    const boot =
      platform === "linux"
        ? await readFile("/proc/sys/kernel/random/boot_id", "utf8")
        : (
            await execute("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
              timeout: 1000,
              maxBuffer: 1024,
              shell: false,
            })
          ).stdout;
    const value = boot.trim();
    return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function platformBootId(platform: NodeJS.Platform): Promise<string | undefined> {
  const present = platformBootIds.get(platform);
  if (present !== undefined) return present;
  const boot = readPlatformBootId(platform);
  platformBootIds.set(platform, boot);
  return boot;
}

function generationEntry(cache: ActiveCache, id: string): ExtensionCacheEntry {
  const directory = path.join(cache.root, "entries", cache.key, id);
  return {
    root: cache.root,
    key: cache.key,
    id,
    directory,
    payload: path.join(directory, "payload"),
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isCacheError(error, "ENOENT")) return false;
    throw error;
  }
}

async function newestEntry(cache: ActiveCache): Promise<ExtensionCacheEntry | undefined> {
  const parent = path.join(cache.root, "entries", cache.key);
  if (!(await exists(parent))) return undefined;
  await inspectPrivateCacheDirectory(parent);
  let newest: { readonly entry: ExtensionCacheEntry; readonly created: bigint } | undefined;
  for (const id of await readdir(parent)) {
    if (!EXTENSION_CACHE_ID.test(id)) continue;
    const entry = generationEntry(cache, id);
    try {
      await inspectPrivateCacheDirectory(entry.directory);
      if (await exists(path.join(entry.directory, "bad"))) continue;
      const stats = await lstat(path.join(entry.directory, "snapshot.json"), { bigint: true });
      if (newest === undefined || stats.mtimeNs > newest.created)
        newest = { entry, created: stats.mtimeNs };
    } catch (error) {
      if (!isCacheError(error, "ENOENT")) continue;
      await markBad(entry);
    }
  }
  return newest?.entry;
}

export async function readExtensionCacheGeneration(
  entry: ExtensionCacheEntry,
  signal?: AbortSignal,
): Promise<ExtensionCacheGeneration> {
  await inspectPrivateCacheDirectory(entry.directory);
  await inspectPrivateCacheDirectory(entry.payload);
  const manifest = await readExtensionCacheManifest(
    path.join(entry.directory, "manifest.jsonl"),
    signal,
  );
  const metadata = await readCacheText(path.join(entry.directory, "snapshot.json"));
  const { createdAt, ...snapshot } = extensionCacheSnapshotMetadata(
    metadata,
    manifest,
    entry.payload,
  );
  return { ...entry, snapshot, createdAt, manifest };
}

async function markBad(entry: ExtensionCacheEntry): Promise<void> {
  try {
    await writeFile(path.join(entry.directory, "bad"), "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isCacheError(error, "EEXIST")) throw error;
  }
}

async function verifyBoot(
  plan: ExtensionSnapshotPlan,
  generation: ExtensionCacheGeneration,
  cache: ActiveCache,
): Promise<boolean> {
  const verified = path.join(generation.directory, "verified-boot");
  const boot = cache.bootId;
  const isCurrent = async (): Promise<boolean> =>
    boot !== undefined &&
    (await readCacheText(verified, 128).catch(() => undefined)) === `${boot}\n`;
  if (await isCurrent()) return true;
  return withNamedExtensionCacheLock(
    path.join(generation.directory, "verify.lock"),
    cache.platform,
    CREATE_WAIT_MS,
    async () => {
      if (await exists(path.join(generation.directory, "bad"))) return false;
      if (await isCurrent()) return true;
      const digest = await recomputeExtensionSnapshotDigest(
        generation.payload,
        generation.manifest,
        generation.snapshot.paths.map((entry) => path.relative(generation.payload, entry)),
        plan.selectedRoots,
        cache.signal,
      );
      if (digest !== generation.snapshot.digest) return false;
      if (boot !== undefined) {
        await withExtensionCacheLock(
          cache.root,
          cache.platform,
          async () => {
            const pending = `${verified}.${newCacheId()}`;
            await writeFile(pending, `${boot}\n`, { mode: 0o600, flag: "wx" });
            try {
              await rename(pending, verified);
            } finally {
              await unlink(pending).catch(() => undefined);
            }
          },
          cache.signal,
        );
      }
      return true;
    },
    cache.signal,
  );
}

function ownedHandle(
  cacheRoot: string,
  payload: string,
  cleanup: Release,
): ExtensionSnapshotHandle {
  let release: Promise<void> | undefined;
  return { cacheRoot, payload, release: () => (release ??= cleanup()) };
}

type Lookup =
  | { readonly type: "hit"; readonly snapshot: CachedExtensionSnapshot }
  | { readonly type: "miss"; readonly id?: string }
  | { readonly type: "bypass" };

async function lookup(
  plan: ExtensionSnapshotPlan,
  cache: ActiveCache,
  seenId?: string,
): Promise<Lookup> {
  const leased = await withExtensionCacheLock(
    cache.root,
    cache.platform,
    async () => {
      const entry = await newestEntry(cache);
      if (entry === undefined || entry.id === seenId) return undefined;
      return { entry, release: await cache.takeLease(entry) };
    },
    cache.signal,
  );
  if (leased === undefined) return { type: "miss" };
  const { entry, release } = leased;
  let owned = false;
  try {
    let generation: ExtensionCacheGeneration;
    try {
      generation = await readExtensionCacheGeneration(entry, cache.signal);
    } catch {
      cache.signal?.throwIfAborted();
      await withExtensionCacheLock(cache.root, cache.platform, () => markBad(entry), cache.signal);
      return { type: "miss", id: entry.id };
    }
    const validation = await cache.validate(plan, entry.payload, generation.manifest, cache.signal);
    if (validation === "run-exclusions") return { type: "bypass" };
    if (validation === "source-mismatch") return { type: "miss", id: entry.id };
    const expected =
      validation === "valid" ? await validateExtensionSnapshot(plan, entry.payload) : undefined;
    if (
      expected === undefined ||
      JSON.stringify(expected.paths) !== JSON.stringify(generation.snapshot.paths) ||
      JSON.stringify(expected.sourcePaths) !== JSON.stringify(generation.snapshot.sourcePaths) ||
      !(await verifyBoot(plan, generation, cache))
    ) {
      await withExtensionCacheLock(cache.root, cache.platform, () => markBad(entry), cache.signal);
      return { type: "miss", id: entry.id };
    }
    owned = true;
    return {
      type: "hit",
      snapshot: {
        ...generation.snapshot,
        snapshotHandle: ownedHandle(cache.root, entry.payload, release),
      },
    };
  } finally {
    if (!owned) await release();
  }
}

type CacheResult = {
  readonly snapshot?: CachedExtensionSnapshot;
  readonly event: ExtensionSnapshotCacheEvent;
};

async function stageCacheEntry(
  plan: ExtensionSnapshotPlan,
  cache: ActiveCache,
): Promise<CacheResult> {
  const id = newCacheId();
  const staging = path.join(cache.root, "staging", id);
  await mkdir(staging, { mode: 0o700 });
  const cleanup = () => rm(staging, { recursive: true, force: true });
  let keepStaging = false;
  try {
    const owner = path.join(staging, "owner");
    await writeFile(owner, cacheProcessOwner(cache.platform, id), { mode: 0o600, flag: "wx" });
    const start = cache.now();
    const payload = path.join(staging, "payload");
    const { manifest, runSpecificFiltered, ...snapshot } = await stageExtensionSnapshot(
      plan,
      payload,
      cache.signal,
      undefined,
      true,
    );
    await writeFile(path.join(payload, "package.json"), EXTENSION_CACHE_PACKAGE_JSON, {
      mode: 0o400,
      flag: "wx",
    });
    const racy = manifest.some(
      (record) => record.source.ctimeNs >= BigInt(start) * 1_000_000n - RACY_MARGIN_NS,
    );
    if (runSpecificFiltered || racy) {
      keepStaging = true;
      return {
        snapshot: { ...snapshot, snapshotHandle: ownedHandle(cache.root, payload, cleanup) },
        event: runSpecificFiltered
          ? { cache: "bypass", reason: "run-exclusions" }
          : { cache: "racy", reason: "recent-source" },
      };
    }
    const relativePaths = snapshot.paths.map((entry) => path.relative(payload, entry));
    await writeExtensionCacheManifest(path.join(staging, "manifest.jsonl"), manifest);
    await writeFile(
      path.join(staging, "snapshot.json"),
      `${JSON.stringify({ ...snapshot, paths: relativePaths, createdAt: cache.now() })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(path.join(staging, "verified-boot"), `${cache.bootId ?? ""}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(path.join(staging, "last-used"), "", { mode: 0o600, flag: "wx" });
    const committed = generationEntry(cache, id);
    const release = await withExtensionCacheLock(
      cache.root,
      cache.platform,
      async () => {
        await createPrivateDirectory(path.dirname(committed.directory));
        await rename(staging, committed.directory);
        await unlink(path.join(committed.directory, "owner"));
        return cache.takeLease(committed);
      },
      cache.signal,
    );
    return {
      snapshot: {
        ...snapshot,
        paths: relativePaths.map((entry) => path.join(committed.payload, entry)),
        snapshotHandle: ownedHandle(cache.root, committed.payload, release),
      },
      event: { cache: "miss", reason: "staged" },
    };
  } finally {
    if (!keepStaging) await cleanup();
  }
}

async function useCache(plan: ExtensionSnapshotPlan, cache: ActiveCache): Promise<CacheResult> {
  const asResult = (lookup: Exclude<Lookup, { type: "miss" }>): CacheResult =>
    lookup.type === "hit"
      ? { snapshot: lookup.snapshot, event: { cache: "hit", reason: "validated" } }
      : { event: { cache: "bypass", reason: "run-exclusions" } };
  const existing = await lookup(plan, cache);
  if (existing.type !== "miss") return asResult(existing);
  const lock = path.join(cache.root, "entries", `${cache.key}.creating`);
  return withNamedExtensionCacheLock(
    lock,
    cache.platform,
    CREATE_WAIT_MS,
    async () => {
      const current = await lookup(plan, cache, existing.id);
      if (current.type !== "miss") return asResult(current);
      return stageCacheEntry(plan, cache);
    },
    cache.signal,
  );
}

/** Acquire a validated generation or stage a run-local replacement. */
export async function prepareCachedExtensionSnapshot(
  plan: ExtensionSnapshotPlan,
  destination: string,
  options: ExtensionCacheOptions = {},
): Promise<CachedExtensionSnapshot> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const cacheRoot = options.cacheRoot ?? extensionCacheRoot(environment, platform);
  await assertExtensionCacheDisjointFromGrants(
    { "extension source": plan.selectedRoots },
    platform,
    cacheRoot,
  );
  const uid = process.getuid?.();
  let result: CacheResult;
  if ((platform !== "darwin" && platform !== "linux") || uid === undefined) {
    result = { event: { cache: "bypass", reason: "unsupported-platform" } };
  } else if (
    environment.PIONEER_EXTENSION_CACHE === "0" ||
    options.validate === undefined ||
    options.takeLease === undefined
  ) {
    result = { event: { cache: "bypass", reason: "disabled" } };
  } else if (plan.enabled.length === 0) {
    result = { event: { cache: "bypass", reason: "empty" } };
  } else {
    const root = await initializeRoot(path.resolve(cacheRoot), platform).catch(() => undefined);
    if (root === undefined) {
      result = { event: { cache: "bypass", reason: "unsafe-cache" } };
    } else {
      const bootId = await (options.readBootId?.() ?? platformBootId(platform)).catch(
        () => undefined,
      );
      options.signal?.throwIfAborted();
      result = await useCache(plan, {
        root,
        key: extensionCacheKey(plan, platform, uid),
        platform,
        bootId,
        now: options.now ?? Date.now,
        signal: options.signal,
        validate: options.validate,
        takeLease: options.takeLease,
      }).catch((error: unknown) => {
        options.signal?.throwIfAborted();
        if (
          error instanceof Error &&
          (error.message.startsWith("[PI_") || error.message.startsWith("Explicit Pi extension"))
        )
          throw error;
        return { event: { cache: "bypass", reason: "cache-unavailable" } };
      });
    }
  }
  try {
    options.record?.(result.event);
    if (result.snapshot !== undefined) return result.snapshot;
  } catch (error) {
    await result.snapshot?.snapshotHandle?.release();
    throw error;
  }
  const {
    manifest: _manifest,
    runSpecificFiltered: _runSpecificFiltered,
    ...snapshot
  } = await stageExtensionSnapshot(plan, destination, options.signal);
  return snapshot;
}
