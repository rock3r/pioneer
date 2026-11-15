import { createHash, type Hash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSensitiveCredentialPathMatcher,
  isBroadExtensionParent,
  isSensitiveCredentialPath,
  isSensitiveSystemExtensionParent,
  protectedExtensionParents,
} from "./eval-run/isolation.js";
import type { PiRuntimeStorage } from "./pi-runtime-storage.js";
import { createPiSessionScanBudget, isPiSessionFile } from "./pi-session-file.js";

const SNAPSHOT_ENTRY_LIMIT = 500_000;
const SNAPSHOT_BYTE_LIMIT = 1024 ** 3;
/** Entries staged at once. Each one waits on several filesystem calls in turn. */
const STAGING_CONCURRENCY = 32;
/** Digest reads that run ahead of the in-order hash, and the largest file read whole for it. */
const DIGEST_PREFETCH_ENTRIES = 64;
const DIGEST_PREFETCH_FILE_BYTES = 1024 ** 2;

/** One digest record, followed by the staged file's bytes when `content` names one. */
interface DigestItem {
  readonly record: string;
  readonly content?: string;
  readonly size?: number;
}

interface StagedEntry {
  readonly items: DigestItem[];
  readonly directory?: {
    readonly canonical: string;
    readonly names: readonly string[];
    readonly ancestors: ReadonlySet<string>;
  };
}

/** A sibling task that did not start because another staging task had already failed. */
class StagingCancelled extends Error {}

/**
 * Runs staging tasks at bounded concurrency. After the first failure no new task starts, and
 * `settle` waits for every started sibling, so nothing still writes when the snapshot fails.
 */
function createStagingWork(signal?: AbortSignal) {
  let active = 0;
  let failed = false;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < STAGING_CONCURRENCY) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        if (failed) throw new StagingCancelled();
        signal?.throwIfAborted();
        return await task();
      } catch (error) {
        if (!(error instanceof StagingCancelled)) failed = true;
        throw error;
      } finally {
        release();
      }
    },
    /** Waits for all tasks, then returns their values in order or the first real failure. */
    async settle<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
      const results = await Promise.allSettled(tasks);
      const values: T[] = [];
      let cancelled: unknown;
      for (const result of results) {
        if (result.status === "fulfilled") values.push(result.value);
        else if (result.reason instanceof StagingCancelled) cancelled ??= result.reason;
        else throw result.reason;
      }
      if (cancelled !== undefined) throw cancelled;
      return values;
    },
  };
}

/**
 * Hashes records and staged bytes in walk order, which keeps the digest that resume archives
 * store. Small files are read ahead concurrently; larger files stream when their turn comes.
 */
async function updateDigestInOrder(
  digest: Hash,
  items: readonly DigestItem[],
  signal?: AbortSignal,
): Promise<void> {
  const reads = new Map<number, Promise<Buffer>>();
  let scheduled = 0;
  for (let index = 0; index < items.length; index += 1) {
    signal?.throwIfAborted();
    for (
      ;
      scheduled < items.length && scheduled <= index + DIGEST_PREFETCH_ENTRIES;
      scheduled += 1
    ) {
      const ahead = items[scheduled];
      if (ahead?.content !== undefined && (ahead.size ?? Infinity) <= DIGEST_PREFETCH_FILE_BYTES) {
        const read = readFile(ahead.content);
        // A failed read surfaces when its turn comes; until then it must not go unhandled.
        read.catch(() => undefined);
        reads.set(scheduled, read);
      }
    }
    const item = items[index];
    if (item === undefined) continue;
    digest.update(item.record);
    digest.update("\0");
    if (item.content === undefined) continue;
    const prefetched = reads.get(index);
    if (prefetched !== undefined) {
      reads.delete(index);
      digest.update(await prefetched);
    } else {
      for await (const chunk of createReadStream(item.content)) digest.update(chunk as Buffer);
    }
  }
}

/** The staged totals, including an earlier caller budget, passed a snapshot limit. */
export class ExtensionSnapshotBudgetError extends Error {}

/** Names the exceeded limit with the running totals, which include any earlier staged budget. */
function snapshotLimitError(entries: number, bytes: number): Error {
  const mebibytes = (bytes / 1024 ** 2).toFixed(1);
  return new ExtensionSnapshotBudgetError(
    entries > SNAPSHOT_ENTRY_LIMIT
      ? `[PI_EXTENSION_SNAPSHOT_LIMIT] Extension code and dependencies exceed the ${SNAPSHOT_ENTRY_LIMIT}-entry snapshot limit (${entries} entries, ${mebibytes} MiB staged).`
      : `[PI_EXTENSION_SNAPSHOT_LIMIT] Extension code and dependencies exceed the 1 GiB snapshot byte limit (${mebibytes} MiB in ${entries} entries staged).`,
  );
}

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
function isMetadataDirectory(name: string): boolean {
  const folded = process.platform === "linux" ? name : name.toLowerCase();
  return folded === ".git" || folded === ".cache" || folded === ".npm";
}

function isSensitiveCredentialFile(name: string): boolean {
  const folded = process.platform === "linux" ? name : name.toLowerCase();
  return (
    folded === ".npmrc" ||
    folded === ".netrc" ||
    folded === ".env" ||
    folded.startsWith(".env.") ||
    folded === ".git-credentials" ||
    folded === ".yarnrc" ||
    folded === ".yarnrc.yml" ||
    folded === ".pypirc"
  );
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

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
  excludedPaths: readonly string[] = [],
): Promise<ExtensionSnapshot> {
  const excluded = new Set<string>();
  const excludedFiles = new Set<string>();
  for (const candidate of excludedPaths) {
    const canonical = await canonicalOrResolved(candidate);
    excluded.add(policyPath(canonical));
    try {
      const identity = await lstat(canonical, { bigint: true });
      if (identity.isFile() && identity.ino !== 0n) {
        excludedFiles.add(`${identity.dev}:${identity.ino}`);
      }
    } catch {
      // A missing controller path has no file identity to match.
    }
  }
  const agentDir = storage === undefined ? undefined : await canonicalOrResolved(storage.agentDir);
  const privateDirectories =
    agentDir === undefined
      ? []
      : await Promise.all(
          [
            path.join(agentDir, "sessions"),
            path.join(agentDir, "logs"),
            path.join(agentDir, "skills"),
            ...(await rootLogFiles(agentDir)),
            ...(storage?.sessionDirs ?? []),
          ].map(async (entry) => policyPath(await canonicalOrResolved(entry))),
        );
  const privateFiles = new Set<string>();
  const maxPrivateFileIdentities = 1024;
  let privateEntriesVisited = 0;
  const rememberPrivateFiles = async (root: string): Promise<boolean> => {
    if (privateEntriesVisited >= maxPrivateFileIdentities) return false;
    signal?.throwIfAborted();
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(root, { bigint: true });
    } catch {
      return true;
    }
    privateEntriesVisited += 1;
    if (privateEntriesVisited > maxPrivateFileIdentities) return false;
    if (details.isSymbolicLink()) return true;
    if (details.isFile()) {
      if (details.ino !== 0n) privateFiles.add(`${details.dev}:${details.ino}`);
      return true;
    }
    if (!details.isDirectory()) return true;
    const dir = await opendir(root);
    try {
      for await (const entry of dir) {
        if (!(await rememberPrivateFiles(path.join(root, entry.name)))) return false;
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    return true;
  };
  if (agentDir !== undefined) {
    const namedCredentials = [
      "auth.json",
      "models.json",
      "models-store.json",
      "settings.json",
      "AGENTS.md",
    ].map((name) => path.join(agentDir, name));
    const privateRoots = [
      ...namedCredentials,
      ...(await rootLogFiles(agentDir)),
      path.join(agentDir, "sessions"),
      path.join(agentDir, "logs"),
      path.join(agentDir, "skills"),
      ...(storage?.sessionDirs ?? []),
    ];
    for (const root of privateRoots) {
      if (!(await rememberPrivateFiles(await canonicalOrResolved(root)))) break;
    }
  }
  const isPrivateStorage = async (canonical: string): Promise<boolean> =>
    privateDirectories.some((entry) => within(entry, policyPath(canonical))) ||
    (agentDir !== undefined &&
      policyPath(path.dirname(canonical)) === policyPath(agentDir) &&
      policyPath(canonical).endsWith(".log") &&
      (await lstat(canonical)).isFile()) ||
    (agentDir !== undefined &&
      policyPath(path.dirname(canonical)) === policyPath(agentDir) &&
      [".json", ".md"].some((suffix) => policyPath(path.basename(canonical)).endsWith(suffix)) &&
      ["auth.json", "models.json", "models-store.json", "settings.json", "agents.md"].includes(
        policyPath(path.basename(canonical)),
      ));
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
  const protectedParents = await protectedExtensionParents();
  for (const root of selectedRoots) {
    const relativeToAgent = agentDir === undefined ? ".." : path.relative(root, agentDir);
    const containsAgent =
      relativeToAgent === "" ||
      (relativeToAgent !== ".." &&
        !relativeToAgent.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeToAgent));
    if (containsAgent || protectedParents.has(root)) {
      throw new Error(
        "Explicit Pi extension must live in a dedicated directory, not a shared temp, home, filesystem root, or a directory that contains the Pi agent directory",
      );
    }
    if (
      isMetadataDirectory(path.basename(root)) ||
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
    if (protectedParents.has(parent)) {
      throw new Error(
        "Explicit Pi extension must live in a dedicated directory, not a shared temp, home, filesystem root, or a directory that contains the Pi agent directory",
      );
    }
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
  // Session-header scans have their own bound, because skipped files are never staged or counted.
  const scans = createPiSessionScanBudget(
    (detail) =>
      new Error(
        `[PI_EXTENSION_SNAPSHOT_LIMIT] Extension ${detail} Move session history and large .jsonl files out of extension directories.`,
      ),
  );
  const isSensitivePath = createSensitiveCredentialPathMatcher();
  const mapped = new Map<string, string>();
  const stagedPath = (source: string): string => mirroredExtensionStagePath(destination, source);
  const work = createStagingWork(signal);
  /**
   * Stages one entry without descending into it. A directory returns its sorted child names, so
   * the caller can stage the children concurrently and still assemble digest items in order.
   */
  async function stageEntry(
    source: string,
    target: string,
    ancestors: ReadonlySet<string>,
    checkCredentialPath: boolean,
  ): Promise<StagedEntry> {
    let canonical: string;
    try {
      canonical = await realpath(source);
    } catch (error) {
      if (checkCredentialPath && isSensitivePath(source)) return { items: [] };
      throw error;
    }
    if (checkCredentialPath && isSensitivePath(source, canonical)) return { items: [] };
    if ([...excluded].some((entry) => within(entry, policyPath(canonical)))) return { items: [] };
    const identity = await lstat(canonical, { bigint: true });
    const fileIdentity = `${identity.dev}:${identity.ino}`;
    if (
      identity.isFile() &&
      identity.ino !== 0n &&
      (excludedFiles.has(fileIdentity) || privateFiles.has(fileIdentity))
    ) {
      return { items: [] };
    }
    if (
      identity.isFile() &&
      identity.ino !== 0n &&
      identity.nlink > 1n &&
      BigInt(rootInodeCounts.get(fileIdentity) ?? 0) < identity.nlink
    ) {
      throw new Error("Explicit Pi extension uses an unsupported hard-link layout");
    }
    if (await isPrivateStorage(canonical)) return { items: [] };
    // Session history can sit anywhere a sessionDir Pioneer cannot see points, so check content.
    if (await isPiSessionFile(canonical, scans, [source, canonical])) return { items: [] };
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
      if (entries > SNAPSHOT_ENTRY_LIMIT) throw snapshotLimitError(entries, bytes);
      const relative = path.relative(path.dirname(target), stagedPath(canonical));
      const record = JSON.stringify([path.relative(destination, target), "symlink", relative]);
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
      return { items: [{ record }] };
    }
    const details = await lstat(canonical);
    if (!stagedAlready) {
      entries += 1;
      bytes += details.isFile() ? details.size : 0;
    }
    if (entries > SNAPSHOT_ENTRY_LIMIT || bytes > SNAPSHOT_BYTE_LIMIT) {
      throw snapshotLimitError(entries, bytes);
    }
    const record = JSON.stringify([
      path.relative(destination, target),
      details.isDirectory() ? "directory" : "file",
      details.isFile() ? details.size : 0,
      details.mode & 0o100,
    ]);
    if (details.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      const names = (await readdir(canonical))
        .sort()
        .filter((name) => !isMetadataDirectory(name) && !isSensitiveCredentialFile(name));
      return {
        items: [{ record }],
        directory: { canonical, names, ancestors: new Set([...ancestors, canonical]) },
      };
    }
    if (!details.isFile())
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] Extension resources must be regular files or directories.",
      );
    if (stagedAlready) {
      const staged = await lstat(target);
      const same =
        staged.size === details.size &&
        (await fileDigest(target)) === (await fileDigest(canonical));
      if (!same) {
        throw new Error(
          "[PI_EXTENSION_SNAPSHOT_CHANGED] Extension code changed while it was being copied; retry after installation has finished.",
        );
      }
      const normalized = details.mode & 0o100 ? 0o700 : 0o600;
      if ((staged.mode & 0o777) !== normalized) await chmod(target, normalized);
      // A resumed caller budget stages into the same tree; the earlier pass hashed these bytes.
      return { items: [{ record }] };
    }
    // A copy-on-write clone shares blocks with the source; filesystems without clones copy bytes.
    await copyFile(canonical, target, constants.COPYFILE_FICLONE);
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
    if (
      await isPiSessionFile(
        target,
        scans,
        [source, canonical],
        Math.max(details.nlink, after.nlink),
      )
    )
      throw new Error(
        "[PI_EXTENSION_SNAPSHOT_CHANGED] A file became Pi session history while it was being copied; retry.",
      );
    await chmod(target, details.mode & 0o100 ? 0o700 : 0o600);
    return { items: [{ record, content: target, size: copied.size }] };
  }
  async function copy(
    source: string,
    target: string,
    ancestors: ReadonlySet<string>,
    checkCredentialPath: boolean,
  ): Promise<DigestItem[]> {
    const staged = await work.run(() => stageEntry(source, target, ancestors, checkCredentialPath));
    if (staged.directory === undefined) return staged.items;
    const { canonical, names, ancestors: next } = staged.directory;
    const children = await work.settle(
      names.map((name) => copy(path.join(canonical, name), path.join(target, name), next, true)),
    );
    return staged.items.concat(children.flat());
  }
  const rootInodeCounts = new Map<string, number>();
  let prepassVisits = 0;
  const countRootInodes = async (file: string): Promise<void> => {
    const names = await work.run(async () => {
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await lstat(file, { bigint: true });
      } catch {
        return [];
      }
      prepassVisits += 1;
      // This scan also visits entries the copy skips, such as .git, and has no shared budget.
      if (prepassVisits > SNAPSHOT_ENTRY_LIMIT) {
        throw new Error(
          `[PI_EXTENSION_SNAPSHOT_LIMIT] The selected extension directories hold more than ${SNAPSHOT_ENTRY_LIMIT} entries to scan, including skipped metadata such as .git. Move the extension into a smaller dedicated directory.`,
        );
      }
      if (details.isSymbolicLink()) return [];
      if (details.isFile()) {
        if (details.ino === 0n) return [];
        const id = `${details.dev}:${details.ino}`;
        rootInodeCounts.set(id, (rootInodeCounts.get(id) ?? 0) + 1);
        // The walk starts at a canonical root and never follows links, so `file` is canonical.
        if (isSensitiveCredentialFile(path.basename(file)) || isSensitivePath(file, file)) {
          excludedFiles.add(id);
        }
        return [];
      }
      if (!details.isDirectory()) return [];
      return await readdir(file);
    });
    await work.settle(names.map((name) => countRootInodes(path.join(file, name))));
  };
  for (const root of selectedRoots) await countRootInodes(root);
  const items: DigestItem[] = [];
  for (const root of selectedRoots) {
    if (await isPrivateStorage(root)) throw refusePrivateStorage();
    const target = stagedPath(root);
    mapped.set(root, target);
    for (const item of await copy(root, target, new Set(), false)) items.push(item);
  }
  const digest = createHash("sha256");
  await updateDigestInOrder(digest, items, signal);
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
