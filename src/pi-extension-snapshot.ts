import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isBroadExtensionParent,
  isSensitiveCredentialPath,
  isSensitiveSystemExtensionParent,
} from "./eval-run/isolation.js";
import type { PiRuntimeStorage } from "./pi-runtime-storage.js";

export interface ExtensionResource {
  readonly path: string;
  readonly enabled: boolean;
  readonly metadata: {
    readonly scope: string;
    readonly origin?: string;
    readonly baseDir?: string;
  };
}

export interface ExtensionSnapshot {
  readonly paths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly digest: string;
  readonly entries: number;
  readonly bytes: number;
}

/** Capability paths have already been canonicalized and validated by their profile. */
export function extensionPathsWithCapabilities(
  snapshot: ExtensionSnapshot,
  capabilityPaths: readonly string[],
): readonly string[] {
  const sources = new Set(snapshot.sourcePaths);
  return [...snapshot.paths, ...new Set(capabilityPaths.filter((entry) => !sources.has(entry)))];
}

export function assertSameExtensionSnapshot(stored: string | undefined, current: string): void {
  if ((stored ?? "0".repeat(64)) !== current) {
    throw new Error(
      "[REVIEW_RESUME_EXTENSIONS_CHANGED] The enabled extension snapshot differs from the retained review. Restore the same extension code and dependencies or start a new review.",
    );
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function policyPath(value: string): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? value.toLowerCase()
    : value;
}

async function canonicalOrResolved(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(value);
    throw error;
  }
}

/** Root log files, including links, so a linked debug log's canonical target is excluded too. */
async function rootLogFiles(agentDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const name of names.filter((entry) => policyPath(entry).endsWith(".log"))) {
    const candidate = path.join(agentDir, name);
    const target = await realpath(candidate).catch(() => undefined);
    if (target !== undefined && (await lstat(target)).isFile()) files.push(candidate);
  }
  return files;
}

/** Copies code as data. No extension is imported in the controller. */
export function mirroredExtensionStagePath(destination: string, source: string): string {
  const parsed = path.parse(source);
  return path.join(
    destination,
    "tree",
    encodeURIComponent(parsed.root),
    path.relative(parsed.root, source),
  );
}

export async function snapshotExtensionResources(
  resources: readonly ExtensionResource[],
  destination: string,
  signal?: AbortSignal,
  storage?: PiRuntimeStorage,
  budget?: { readonly entries: number; readonly bytes: number },
): Promise<ExtensionSnapshot> {
  const agentDir = storage === undefined ? undefined : await canonicalOrResolved(storage.agentDir);
  const privateDirectories =
    agentDir === undefined
      ? []
      : await Promise.all(
          [
            path.join(agentDir, "sessions"),
            path.join(agentDir, "logs"),
            ...(await rootLogFiles(agentDir)),
            ...(storage?.sessionDirs ?? []),
          ].map(async (entry) => policyPath(await canonicalOrResolved(entry))),
        );
  const isPrivateStorage = async (canonical: string): Promise<boolean> =>
    privateDirectories.some((entry) => within(entry, policyPath(canonical))) ||
    (agentDir !== undefined &&
      policyPath(path.dirname(canonical)) === policyPath(agentDir) &&
      policyPath(canonical).endsWith(".log") &&
      (await lstat(canonical)).isFile());
  const refusePrivateStorage = (): Error =>
    new Error(
      "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension is stored inside private Pi session or log storage. Move it to a dedicated extension directory.",
    );
  const enabled = resources.filter(
    (resource) => resource.enabled && resource.metadata.scope === "user",
  );
  const roots = new Set<string>();
  for (const resource of enabled) {
    signal?.throwIfAborted();
    let root = path.dirname(resource.path);
    const base = resource.metadata.baseDir;
    if (resource.metadata.origin === "package" && base !== undefined) root = base;
    else if (base !== undefined && within(path.join(base, "extensions"), resource.path))
      root = path.join(base, "extensions");
    root = await realpath(root);
    const canonicalEntry = await realpath(resource.path);
    if (!within(root, canonicalEntry)) root = path.dirname(canonicalEntry);
    const modulesSegment = `${path.sep}node_modules${path.sep}`;
    const modulesIndex = root.indexOf(modulesSegment);
    if (modulesIndex >= 0) root = root.slice(0, modulesIndex + modulesSegment.length - 1);
    if (root === path.parse(root).root || within(root, await realpath(os.homedir()))) {
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] Put local extensions in a dedicated directory with their dependencies and assets; a home or filesystem root cannot be staged.",
      );
    }
    roots.add(root);
    for (
      let ancestor = root;
      ancestor !== path.dirname(ancestor);
      ancestor = path.dirname(ancestor)
    ) {
      const modules = path.join(ancestor, "node_modules");
      try {
        if ((await lstat(modules)).isDirectory()) roots.add(await realpath(modules));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const selectedRoots = [...roots]
    .sort()
    .filter((root) => ![...roots].some((other) => other !== root && within(other, root)));
  for (const root of selectedRoots) {
    if (
      isSensitiveCredentialPath(path.join(root, "entry.mjs")) ||
      isBroadExtensionParent(root) ||
      isSensitiveSystemExtensionParent(root)
    ) {
      throw new Error(
        "Explicit Pi extension must not be staged from a credential directory such as .ssh or .aws",
      );
    }
  }
  for (const resource of enabled) {
    const canonical = await realpath(resource.path);
    const parent = path.dirname(canonical);
    if (
      isSensitiveCredentialPath(canonical) ||
      isBroadExtensionParent(parent) ||
      isSensitiveSystemExtensionParent(parent)
    ) {
      throw new Error(
        "Explicit Pi extension must not be staged from a credential directory such as .ssh or .aws",
      );
    }
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let entries = budget?.entries ?? 0;
  let bytes = budget?.bytes ?? 0;
  const digest = createHash("sha256");
  const mapped = new Map<string, string>();
  const stagedPath = (source: string): string => mirroredExtensionStagePath(destination, source);
  async function copy(
    source: string,
    target: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    signal?.throwIfAborted();
    const canonical = await realpath(source);
    if (await isPrivateStorage(canonical)) return;
    if (!selectedRoots.some((root) => within(root, canonical))) {
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension dependency link escapes the selected code directories. Install its dependencies inside the package before retrying.",
      );
    }
    if (ancestors.has(canonical))
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension dependency contains a symlink cycle.",
      );
    const lexical = await lstat(source);
    let stagedAlready = false;
    try {
      await lstat(target);
      stagedAlready = true;
    } catch {
      stagedAlready = false;
    }
    if (lexical.isSymbolicLink()) {
      if (!stagedAlready) entries += 1;
      if (entries > 500_000)
        throw new Error("[PI_EXTENSION_SNAPSHOT_LIMIT] Too many extension dependency links.");
      const relative = path.relative(path.dirname(target), stagedPath(canonical));
      digest.update(JSON.stringify([path.relative(destination, target), "symlink", relative]));
      digest.update("\0");
      try {
        await symlink(relative, target);
      } catch (error) {
        const exists =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "EEXIST";
        if (!exists) throw error;
        if ((await readlink(target)) !== relative) {
          throw new Error(
            "[PI_EXTENSION_SNAPSHOT_CHANGED] Extension code changed while it was being copied; retry after installation has finished.",
          );
        }
      }
      return;
    }
    const details = await lstat(canonical);
    if (!stagedAlready) {
      entries += 1;
      bytes += details.isFile() ? details.size : 0;
    }
    if (entries > 500_000 || bytes > 1024 ** 3) {
      throw new Error(
        "[PI_EXTENSION_SNAPSHOT_LIMIT] Extension code and dependencies exceed the 1 GiB or 500000-entry snapshot limit.",
      );
    }
    digest.update(
      JSON.stringify([
        path.relative(destination, target),
        details.isDirectory() ? "directory" : "file",
        details.isFile() ? details.size : 0,
        details.mode & 0o100,
      ]),
    );
    digest.update("\0");
    if (details.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      const next = new Set([...ancestors, canonical]);
      for (const name of (await readdir(canonical)).sort()) {
        if ([".git", ".cache", ".npm"].includes(name)) continue;
        await copy(path.join(canonical, name), path.join(target, name), next);
      }
    } else if (details.isFile()) {
      if (stagedAlready) return;
      await copyFile(canonical, target);
      const copied = await lstat(target);
      const after = await lstat(canonical);
      if (
        after.ino !== details.ino ||
        after.dev !== details.dev ||
        after.size !== details.size ||
        copied.size !== details.size ||
        after.mtimeMs !== details.mtimeMs
      ) {
        throw new Error(
          "[PI_EXTENSION_SNAPSHOT_CHANGED] Extension code changed while it was being copied; retry after installation has finished.",
        );
      }
      await chmod(target, details.mode & 0o100 ? 0o700 : 0o600);
      for await (const chunk of createReadStream(target)) digest.update(chunk as Buffer);
    } else
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] Extension resources must be regular files or directories.",
      );
  }
  for (const root of selectedRoots) {
    if (await isPrivateStorage(root)) throw refusePrivateStorage();
    const target = stagedPath(root);
    mapped.set(root, target);
    await copy(root, target, new Set());
  }
  const paths: string[] = [];
  const sourcePaths: string[] = [];
  for (const resource of enabled) {
    const canonical = await realpath(resource.path);
    if (await isPrivateStorage(canonical)) throw refusePrivateStorage();
    const root = selectedRoots.find((candidate) => within(candidate, canonical));
    if (root === undefined)
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension entry escapes its staged package directory.",
      );
    const staged = path.join(mapped.get(root) ?? "", path.relative(root, canonical));
    if (!paths.includes(staged)) {
      paths.push(staged);
      sourcePaths.push(canonical);
    }
  }
  digest.update(JSON.stringify(paths.map((entry) => path.relative(destination, entry))));
  return { paths, sourcePaths, digest: digest.digest("hex"), entries, bytes };
}
