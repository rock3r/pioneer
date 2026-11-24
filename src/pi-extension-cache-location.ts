import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalProspectivePathForContainment } from "./stable-directory.js";

export function pioneerCacheDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const configured = environment.XDG_CACHE_HOME;
  const base =
    configured && path.isAbsolute(configured)
      ? configured
      : platform === "darwin"
        ? path.join(home, "Library", "Caches")
        : path.join(home, ".cache");
  return path.join(base, "pioneer");
}

export function extensionCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  return path.join(pioneerCacheDirectory(environment, platform, home), "extension-snapshots", "v1");
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function extensionCacheDirectory(versionRoot: string): string {
  const parent = path.dirname(versionRoot);
  return path.basename(parent) === "extension-snapshots" ? parent : versionRoot;
}

export class ExtensionCacheGrantOverlapError extends Error {
  constructor(label: string, grant: string, cache: string) {
    super(
      `[PI_EXTENSION_CACHE_GRANT_OVERLAP] The ${label} grant ${grant} overlaps Pioneer's extension cache at ${cache}. Pass a narrower grant outside that directory.`,
    );
  }
}

type GrantPathFailure = "not found" | "not readable" | "symbolic link";

export class ExtensionCacheGrantResolutionError extends Error {
  constructor(
    label: string,
    readonly grant: string,
    readonly reason: GrantPathFailure,
    cause: unknown,
  ) {
    super(
      `[PI_EXTENSION_CACHE_GRANT_UNAVAILABLE] Could not resolve the ${label} grant ${grant} (${reason}) before checking extension cache isolation. Name an existing readable path.`,
      { cause },
    );
  }
}

function pathResolutionFailure(error: unknown): "not found" | "not readable" | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "not found";
  if (code === "ENOTDIR" || code === "ELOOP" || code === "EACCES" || code === "EPERM")
    return "not readable";
  return undefined;
}

async function resolveCacheGrant(label: string, grant: string): Promise<string> {
  try {
    return await canonicalProspectivePathForContainment(grant);
  } catch (error) {
    const failure = pathResolutionFailure(error);
    if (failure === undefined) throw error;
    const stats = await lstat(grant).catch(() => undefined);
    throw new ExtensionCacheGrantResolutionError(
      label,
      grant,
      stats?.isSymbolicLink() ? "symbolic link" : failure,
      error,
    );
  }
}

/** Keep even a disabled cache outside user grants. A different process can hold a live lease. */
export async function assertExtensionCacheDisjointFromGrants(
  grants: Readonly<Record<string, readonly string[]>>,
  platform: NodeJS.Platform = process.platform,
  versionRoot = extensionCacheRoot(process.env, platform),
): Promise<void> {
  if (platform === "win32") return;
  const cache = path.resolve(extensionCacheDirectory(versionRoot));
  const normalize = (entry: string) =>
    platform === "darwin" ? entry.normalize("NFD").toLowerCase() : entry;
  const canonical = await canonicalProspectivePathForContainment(cache).catch((error: unknown) => {
    // The store will bypass an unusable directory. The lexical path still needs protection.
    if (pathResolutionFailure(error) !== undefined) return cache;
    throw error;
  });
  const roots = [normalize(cache), normalize(canonical)];
  const overlapsCache = (entry: string): boolean => {
    const name = normalize(entry);
    return roots.some((root) => contains(root, name) || contains(name, root));
  };
  for (const [label, paths] of Object.entries(grants)) {
    for (const grant of new Set(paths)) {
      const absolute = path.resolve(grant);
      if (overlapsCache(absolute) || overlapsCache(await resolveCacheGrant(label, absolute))) {
        throw new ExtensionCacheGrantOverlapError(label, grant, cache);
      }
    }
  }
}
