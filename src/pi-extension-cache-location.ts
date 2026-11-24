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
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "ELOOP" ||
      code === "EACCES" ||
      code === "EPERM"
    )
      return cache;
    throw error;
  });
  const roots = [normalize(cache), normalize(canonical)];
  for (const [label, paths] of Object.entries(grants)) {
    for (const grant of new Set(paths)) {
      const names = [
        normalize(path.resolve(grant)),
        normalize(await canonicalProspectivePathForContainment(grant)),
      ];
      if (
        names.some((name) => roots.some((root) => contains(root, name) || contains(name, root)))
      ) {
        throw new Error(
          `[PI_EXTENSION_CACHE_GRANT_OVERLAP] The ${label} grant ${grant} overlaps Pioneer's extension cache at ${cache}. Pass a narrower grant outside that directory.`,
        );
      }
    }
  }
}
