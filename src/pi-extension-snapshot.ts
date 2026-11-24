import { createHash, type Hash } from "node:crypto";
import { type BigIntStats, constants, createReadStream } from "node:fs";
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
  type CredentialPathRoots,
  credentialPathRoots,
  isBroadExtensionParent,
  isSensitiveCredentialPath,
  isSensitiveSystemExtensionParent,
  protectedExtensionParents,
  sensitiveCredentialPathMatcher,
} from "./eval-run/isolation.js";
import { type WalkLevel, walkBounded } from "./pi-extension-snapshot-walk.js";
import type { PiRuntimeStorage } from "./pi-runtime-storage.js";
import { createPiSessionScanBudget, isPiSessionFile } from "./pi-session-file.js";

export const SNAPSHOT_ENTRY_LIMIT = 500_000;
const SNAPSHOT_BYTE_LIMIT = 1024 ** 3;
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

/** Staged digest items of one entry, and of its children in sorted order once visited. */
interface DigestNode {
  readonly items: readonly DigestItem[];
  children?: (DigestNode | undefined)[];
}

/** Flattens digest nodes in pre-order without recursion, which keeps the 0.4.8 order. */
function flattenDigestItems(nodes: readonly (DigestNode | undefined)[]): DigestItem[] {
  const items: DigestItem[] = [];
  const stack = [{ nodes, next: 0 }];
  for (;;) {
    const top = stack[stack.length - 1];
    if (top === undefined) return items;
    if (top.next >= top.nodes.length) {
      stack.pop();
      continue;
    }
    const node = top.nodes[top.next];
    top.next += 1;
    if (node === undefined) continue;
    for (const item of node.items) items.push(item);
    if (node.children !== undefined) stack.push({ nodes: node.children, next: 0 });
  }
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

export interface ExtensionSnapshotPlan {
  readonly enabled: readonly ExtensionResource[];
  readonly selectedRoots: readonly string[];
  readonly entryPoints: ReadonlySet<string>;
  readonly repositorySessionDirs: readonly string[];
  readonly agentDir: string | undefined;
  readonly privateDirectories: readonly string[];
  readonly privateFiles: ReadonlySet<string>;
  readonly credentialPathRoots: CredentialPathRoots;
  readonly excluded: ReadonlySet<string>;
  readonly excludedFiles: ReadonlySet<string>;
}

type StagedMetadata = Pick<BigIntStats, "ino" | "size" | "mode" | "mtimeNs" | "ctimeNs">;

interface ManifestSource {
  /** A canonical location that names the link itself for a symlink. */
  readonly sourcePath: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly source: StagedMetadata & Pick<BigIntStats, "dev" | "nlink">;
  readonly linkText?: string;
}

export type ExtensionManifestRecord = ManifestSource &
  (
    | { readonly staged: false; readonly skippedLinkTarget?: string }
    | {
        readonly staged: true;
        readonly stagedRelativePath: string;
        readonly stagedMetadata: StagedMetadata;
      }
  );

export interface StagedExtensionSnapshot extends ExtensionSnapshot {
  /** Controller-only. Includes names and metadata from excluded portions of the source tree. */
  readonly manifest: readonly ExtensionManifestRecord[];
  /** A caller-specific filter omitted an entry from this copy. */
  readonly runSpecificFiltered: boolean;
}

interface ObservedEntry extends ManifestSource {
  readonly stagedRelativePath?: string;
  readonly skippedLinkTarget?: string;
}

class ExtensionSnapshotChangedError extends Error {
  constructor() {
    super(
      "[PI_EXTENSION_SNAPSHOT_CHANGED] Extension code changed while it was being copied; retry after installation has finished.",
    );
  }
}

function sameSource(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.ino === before.ino &&
    after.dev === before.dev &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  );
}

function isLinkObservationRace(error: unknown): boolean {
  return (
    error instanceof ExtensionSnapshotChangedError ||
    (error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EINVAL"))
  );
}

function stagedMetadata(details: BigIntStats): StagedMetadata {
  const { ino, size, mode, mtimeNs, ctimeNs } = details;
  return { ino, size, mode, mtimeNs, ctimeNs };
}

async function observeSource(
  sourcePath: string,
  details: BigIntStats,
  expectedTarget?: string,
): Promise<ManifestSource> {
  const type = details.isSymbolicLink()
    ? "symlink"
    : details.isFile()
      ? "file"
      : details.isDirectory()
        ? "directory"
        : "other";
  const source = { ...stagedMetadata(details), dev: details.dev, nlink: details.nlink };
  if (type === "symlink") {
    const linkText = await readlink(sourcePath);
    if (expectedTarget !== undefined && (await realpath(sourcePath)) !== expectedTarget)
      throw new ExtensionSnapshotChangedError();
    if (!sameSource(details, await lstat(sourcePath, { bigint: true })))
      throw new ExtensionSnapshotChangedError();
    return { sourcePath, type, source, linkText };
  }
  return { sourcePath, type, source };
}

async function lstatIfPresent(sourcePath: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(sourcePath, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryObserveSource(
  sourcePath: string,
  details: BigIntStats,
): Promise<{ readonly record: ManifestSource; readonly details: BigIntStats } | undefined> {
  try {
    return { record: await observeSource(sourcePath, details), details };
  } catch (error) {
    if (isLinkObservationRace(error)) return undefined;
    throw error;
  }
}

/** Give an entry that changed during the prepass one chance to supply a coherent record. */
async function observeSourceBestEffort(
  sourcePath: string,
  details: BigIntStats,
): ReturnType<typeof tryObserveSource> {
  const observation = await tryObserveSource(sourcePath, details);
  if (observation !== undefined) return observation;
  const replacement = await lstatIfPresent(sourcePath);
  return replacement === undefined ? undefined : tryObserveSource(sourcePath, replacement);
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

function directoryPrefix(dir: string): string {
  return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
}

function privateStorageMatcher(plan: ExtensionSnapshotPlan) {
  const directories = plan.privateDirectories.map((dir) => [dir, directoryPrefix(dir)] as const);
  const agent =
    plan.agentDir === undefined ? undefined : directoryPrefix(policyPath(plan.agentDir));
  return (canonical: string): "private" | "root-log" | undefined => {
    const candidate = policyPath(canonical);
    for (const [dir, prefix] of directories) {
      if (candidate === dir || candidate.startsWith(prefix)) return "private";
    }
    if (agent === undefined || !candidate.startsWith(agent)) return undefined;
    const name = candidate.slice(agent.length);
    if (name.includes(path.sep)) return undefined;
    if (name.endsWith(".log")) return "root-log";
    return ["auth.json", "models.json", "models-store.json", "settings.json", "agents.md"].includes(
      name,
    )
      ? "private"
      : undefined;
  };
}

async function isPrivateStorage(canonical: string, plan: ExtensionSnapshotPlan): Promise<boolean> {
  const match = privateStorageMatcher(plan)(canonical);
  return match === "private" || (match === "root-log" && (await lstat(canonical)).isFile());
}

function isRepositorySessionFile(
  source: string,
  canonical: string,
  plan: ExtensionSnapshotPlan,
): boolean {
  if (plan.repositorySessionDirs.length === 0) return false;
  const file = policyPath(canonical);
  return (
    file.endsWith(".jsonl") &&
    !plan.entryPoints.has(file) &&
    plan.repositorySessionDirs.some((dir) => within(dir, file) || within(dir, policyPath(source)))
  );
}

function createExtensionSessionScanBudget() {
  // Session-header scans have their own bound, because skipped files are never staged or counted.
  return createPiSessionScanBudget(
    (detail) =>
      new Error(
        `[PI_EXTENSION_SNAPSHOT_LIMIT] Extension ${detail} Move session history and large .jsonl files out of extension directories.`,
      ),
  );
}

function refusePrivateStorage(): Error {
  return new Error(
    "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension is stored inside private Pi session or log storage. Move it to a dedicated extension directory.",
  );
}

export async function planExtensionSnapshot(
  resources: readonly ExtensionResource[],
  signal?: AbortSignal,
  storage?: PiRuntimeStorage,
  excludedPaths: readonly string[] = [],
): Promise<ExtensionSnapshotPlan> {
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
  const enabled = resources.filter(
    (resource) => resource.enabled && resource.metadata.scope === "user",
  );
  const repositorySessionDirs = storage?.repositorySessionDirs?.map(policyPath) ?? [];
  const entryPoints = new Set<string>();
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
    entryPoints.add(policyPath(canonicalEntry));
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
  return {
    enabled,
    selectedRoots,
    entryPoints,
    repositorySessionDirs,
    agentDir,
    privateDirectories,
    privateFiles,
    credentialPathRoots: credentialPathRoots(),
    excluded,
    excludedFiles,
  };
}

export async function stageExtensionSnapshot(
  plan: ExtensionSnapshotPlan,
  destination: string,
  signal?: AbortSignal,
  budget?: { readonly entries: number; readonly bytes: number },
  readOnly = false,
): Promise<StagedExtensionSnapshot> {
  const { selectedRoots, excluded, privateFiles } = plan;
  const excludedFiles = new Set(plan.excludedFiles);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let entries = budget?.entries ?? 0;
  let bytes = budget?.bytes ?? 0;
  let runSpecificFiltered = false;
  const scans = createExtensionSessionScanBudget();
  const isSensitivePath = sensitiveCredentialPathMatcher(plan.credentialPathRoots);
  const privateStorage = privateStorageMatcher(plan);
  const observed = new Map<string, ObservedEntry>();
  const stagedPath = (source: string): string => mirroredExtensionStagePath(destination, source);
  async function skipEntry(source: string, canonical?: string): Promise<StagedEntry> {
    // Most skips were already recorded by the prepass. An entry can appear between walks.
    if (!observed.has(source)) {
      const details = await lstatIfPresent(source);
      if (details !== undefined) {
        const observation = await observeSourceBestEffort(source, details);
        if (observation !== undefined) observed.set(source, observation.record);
      }
    }
    const record = observed.get(source);
    if (canonical !== undefined && record?.type === "symlink") {
      observed.set(source, { ...record, skippedLinkTarget: canonical });
    }
    return { items: [] };
  }
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
      if (checkCredentialPath && isSensitivePath(source)) return skipEntry(source);
      throw error;
    }
    if (checkCredentialPath && isSensitivePath(source, canonical))
      return skipEntry(source, canonical);
    if ([...excluded].some((entry) => within(entry, policyPath(canonical)))) {
      runSpecificFiltered = true;
      return skipEntry(source, canonical);
    }
    const identity = await lstat(canonical, { bigint: true });
    const fileIdentity = `${identity.dev}:${identity.ino}`;
    if (
      identity.isFile() &&
      identity.ino !== 0n &&
      (excludedFiles.has(fileIdentity) || privateFiles.has(fileIdentity))
    ) {
      if (plan.excludedFiles.has(fileIdentity)) runSpecificFiltered = true;
      return skipEntry(source, canonical);
    }
    if (
      identity.isFile() &&
      identity.ino !== 0n &&
      identity.nlink > 1n &&
      BigInt(rootInodeCounts.get(fileIdentity) ?? 0) < identity.nlink
    ) {
      throw new Error("Explicit Pi extension uses an unsupported hard-link layout");
    }
    const privateMatch = privateStorage(canonical);
    if (privateMatch === "private" || (privateMatch === "root-log" && identity.isFile()))
      return skipEntry(source, canonical);
    // Project settings can only exclude session-shaped data, never an enabled entry point.
    if (identity.isFile() && isRepositorySessionFile(source, canonical, plan)) {
      runSpecificFiltered = true;
      return skipEntry(source, canonical);
    }
    // Session history can sit anywhere a sessionDir Pioneer cannot see points, so check content.
    if (await isPiSessionFile(canonical, scans, [source, canonical]))
      return skipEntry(source, canonical);
    if (!selectedRoots.some((root) => within(root, canonical))) {
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension dependency link escapes the selected code directories. Install its dependencies inside the package before retrying.",
      );
    }
    if (ancestors.has(canonical))
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension dependency contains a symlink cycle.",
      );
    const lexical = await lstatIfPresent(source);
    if (lexical === undefined) throw new ExtensionSnapshotChangedError();
    const stagedRelativePath = path.relative(destination, target);
    let stagedAlready = false;
    try {
      await lstat(target);
      stagedAlready = true;
    } catch {
      stagedAlready = false;
    }
    if (lexical.isSymbolicLink()) {
      let observedSource: ManifestSource;
      try {
        observedSource = await observeSource(source, lexical, canonical);
      } catch (error) {
        if (isLinkObservationRace(error)) throw new ExtensionSnapshotChangedError();
        throw error;
      }
      if (!stagedAlready) entries += 1;
      if (entries > SNAPSHOT_ENTRY_LIMIT) throw snapshotLimitError(entries, bytes);
      const relative = path.relative(path.dirname(target), stagedPath(canonical));
      const record = JSON.stringify([stagedRelativePath, "symlink", relative]);
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
          throw new ExtensionSnapshotChangedError();
        }
      }
      observed.set(source, { ...observedSource, stagedRelativePath });
      return { items: [{ record }] };
    }
    if (path.relative(source, canonical) !== "") throw new ExtensionSnapshotChangedError();
    const details = await lstat(canonical, { bigint: true });
    const size = details.isFile() ? Number(details.size) : 0;
    const ownerExecute = Number(details.mode & 0o100n);
    const fileMode = (readOnly ? 0o400 : 0o600) | ownerExecute;
    if (!stagedAlready) {
      entries += 1;
      bytes += size;
    }
    if (entries > SNAPSHOT_ENTRY_LIMIT || bytes > SNAPSHOT_BYTE_LIMIT) {
      throw snapshotLimitError(entries, bytes);
    }
    const record = JSON.stringify([
      stagedRelativePath,
      details.isDirectory() ? "directory" : "file",
      size,
      ownerExecute,
    ]);
    observed.set(source, {
      ...(await observeSource(source, details)),
      stagedRelativePath,
    });
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
        staged.size === size && (await fileDigest(target)) === (await fileDigest(canonical));
      if (!same) {
        throw new ExtensionSnapshotChangedError();
      }
      if ((staged.mode & 0o777) !== fileMode) await chmod(target, fileMode);
      // A resumed caller budget stages into the same tree; the earlier pass hashed these bytes.
      return { items: [{ record }] };
    }
    // A copy-on-write clone shares blocks with the source; filesystems without clones copy bytes.
    await copyFile(canonical, target, constants.COPYFILE_FICLONE);
    const copied = await lstat(target);
    const after = await lstat(canonical, { bigint: true });
    if (!sameSource(details, after) || copied.size !== size)
      throw new ExtensionSnapshotChangedError();
    if (
      await isPiSessionFile(
        target,
        scans,
        [source, canonical],
        Number(details.nlink > after.nlink ? details.nlink : after.nlink),
      )
    )
      throw new Error(
        "[PI_EXTENSION_SNAPSHOT_CHANGED] A file became Pi session history while it was being copied; retry.",
      );
    await chmod(target, fileMode);
    return { items: [{ record, content: target, size: copied.size }] };
  }
  /** A pending copy: where the entry comes from, where it goes, and its digest slot. */
  interface CopyEntry {
    readonly source: string;
    readonly target: string;
    readonly ancestors: ReadonlySet<string>;
    readonly checkCredentialPath: boolean;
    readonly slots: (DigestNode | undefined)[];
    readonly index: number;
  }
  const copy = async (entry: CopyEntry): Promise<WalkLevel<CopyEntry> | undefined> => {
    const staged = await stageEntry(
      entry.source,
      entry.target,
      entry.ancestors,
      entry.checkCredentialPath,
    );
    const node: DigestNode = { items: staged.items };
    entry.slots[entry.index] = node;
    if (staged.directory === undefined) return undefined;
    const { canonical, names, ancestors } = staged.directory;
    const slots = new Array<DigestNode | undefined>(names.length);
    node.children = slots;
    return {
      size: names.length,
      next: 0,
      child: (index) => {
        const name = names[index] ?? "";
        return {
          source: path.join(canonical, name),
          target: path.join(entry.target, name),
          ancestors,
          checkCredentialPath: true,
          slots,
          index,
        };
      },
    };
  };
  const rootInodeCounts = new Map<string, number>();
  let prepassVisits = 0;
  // The roots count too, so the queued total never trails the entries the scan will visit.
  let prepassQueued = selectedRoots.length;
  const prepassLimitError = (): Error =>
    new Error(
      `[PI_EXTENSION_SNAPSHOT_LIMIT] The selected extension directories hold more than ${SNAPSHOT_ENTRY_LIMIT} entries to scan, including skipped metadata such as .git. Move the extension into a smaller dedicated directory.`,
    );
  const countRootInodes = async (file: string): Promise<WalkLevel<string> | undefined> => {
    let details: BigIntStats;
    try {
      details = await lstat(file, { bigint: true });
    } catch {
      return undefined;
    }
    prepassVisits += 1;
    // This scan also visits entries the copy skips, such as .git, and has no shared budget.
    if (prepassVisits > SNAPSHOT_ENTRY_LIMIT) throw prepassLimitError();
    const observation = await observeSourceBestEffort(file, details);
    if (observation === undefined) return undefined;
    observed.set(file, observation.record);
    details = observation.details;
    if (details.isSymbolicLink()) return undefined;
    if (details.isFile()) {
      if (details.ino === 0n) return undefined;
      const id = `${details.dev}:${details.ino}`;
      rootInodeCounts.set(id, (rootInodeCounts.get(id) ?? 0) + 1);
      // The walk starts at a canonical root and never follows links, so `file` is canonical.
      if (isSensitiveCredentialFile(path.basename(file)) || isSensitivePath(file, file)) {
        excludedFiles.add(id);
      }
      return undefined;
    }
    if (!details.isDirectory()) return undefined;
    // Read lazily and count every name before it is queued, so an oversized directory fails
    // at the limit instead of visiting its children first.
    const names: string[] = [];
    const directory = await opendir(file);
    for await (const child of directory) {
      prepassQueued += 1;
      if (prepassQueued > SNAPSHOT_ENTRY_LIMIT) throw prepassLimitError();
      names.push(child.name);
    }
    return { size: names.length, next: 0, child: (index) => path.join(file, names[index] ?? "") };
  };
  if (prepassQueued > SNAPSHOT_ENTRY_LIMIT) throw prepassLimitError();
  await walkBounded(
    { size: selectedRoots.length, next: 0, child: (index) => selectedRoots[index] ?? "" },
    countRootInodes,
    signal,
  );
  const rootSlots = new Array<DigestNode | undefined>(selectedRoots.length);
  const rootEntries: CopyEntry[] = [];
  for (const [index, root] of selectedRoots.entries()) {
    if (await isPrivateStorage(root, plan)) throw refusePrivateStorage();
    const target = stagedPath(root);
    rootEntries.push({
      source: root,
      target,
      ancestors: new Set(),
      checkCredentialPath: false,
      slots: rootSlots,
      index,
    });
  }
  await walkBounded(
    { size: rootEntries.length, next: 0, child: (index) => rootEntries[index] as CopyEntry },
    copy,
    signal,
  );
  const items = flattenDigestItems(rootSlots);
  const digest = createHash("sha256");
  await updateDigestInOrder(digest, items, signal);
  const { paths, sourcePaths } = await validateExtensionSnapshot(plan, destination);
  digest.update(JSON.stringify(paths.map((entry) => path.relative(destination, entry))));
  const manifest = await finalizeExtensionManifest(destination, observed, signal);
  return {
    paths,
    sourcePaths,
    digest: digest.digest("hex"),
    entries,
    bytes,
    manifest,
    runSpecificFiltered,
  };
}

/** Reproduce staging's pre-order hash using the source modes and current staged bytes. */
export async function recomputeExtensionSnapshotDigest(
  destination: string,
  manifest: readonly ExtensionManifestRecord[],
  relativePaths: readonly string[],
  selectedRoots: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const staged = manifest.flatMap((record) => {
    if (!record.staged) return [];
    const rootIndex = selectedRoots.findIndex((root) => within(root, record.sourcePath));
    if (rootIndex < 0) throw new ExtensionSnapshotChangedError();
    // Replacing separators with NUL keeps the traversal pre-order even when a sibling
    // sorts before the platform path separator (for example "a-test" and "a/item").
    return [{ record, rootIndex, order: record.stagedRelativePath.replaceAll(path.sep, "\0") }];
  });
  staged.sort((left, right) => {
    if (left.rootIndex !== right.rootIndex) return left.rootIndex - right.rootIndex;
    if (left.order === right.order) return 0;
    return left.order < right.order ? -1 : 1;
  });
  const items: DigestItem[] = [];
  for (const { record } of staged) {
    signal?.throwIfAborted();
    const relative = record.stagedRelativePath;
    const content = path.join(destination, relative);
    if (record.type === "symlink") {
      items.push({ record: JSON.stringify([relative, "symlink", await readlink(content)]) });
    } else {
      const size = record.type === "file" ? Number(record.source.size) : 0;
      items.push({
        record: JSON.stringify([relative, record.type, size, Number(record.source.mode & 0o100n)]),
        ...(record.type === "file" ? { content, size } : {}),
      });
    }
  }
  const digest = createHash("sha256");
  await updateDigestInOrder(digest, items, signal);
  digest.update(JSON.stringify(relativePaths));
  return digest.digest("hex");
}

async function finalizeExtensionManifest(
  destination: string,
  observed: ReadonlyMap<string, ObservedEntry>,
  signal?: AbortSignal,
): Promise<readonly ExtensionManifestRecord[]> {
  const entries = [...observed.values()];
  const manifest = new Array<ExtensionManifestRecord>(entries.length);
  await walkBounded(
    { size: entries.length, next: 0, child: (index) => index },
    async (index) => {
      const { stagedRelativePath, skippedLinkTarget, ...entry } = entries[index] as ObservedEntry;
      if (stagedRelativePath === undefined) {
        manifest[index] = {
          ...entry,
          staged: false,
          ...(skippedLinkTarget === undefined ? {} : { skippedLinkTarget }),
        };
      } else {
        const details = await lstat(path.join(destination, stagedRelativePath), { bigint: true });
        manifest[index] = {
          ...entry,
          staged: true,
          stagedRelativePath,
          stagedMetadata: stagedMetadata(details),
        };
      }
      return undefined;
    },
    signal,
  );
  return manifest;
}

class ExtensionCachePolicyMismatch extends Error {}
class ExtensionCacheRunExclusion extends Error {}

/** Revalidate policies that depend on the current run or on data outside the walked trees. */
export async function validateCachedExtensionRunPolicy(
  plan: ExtensionSnapshotPlan,
  payload: string,
  sourceManifest: ReadonlyMap<string, ExtensionManifestRecord>,
  manifest: readonly ExtensionManifestRecord[],
  signal?: AbortSignal,
): Promise<"valid" | "source-mismatch" | "run-exclusions"> {
  const scans = createExtensionSessionScanBudget();
  const isSensitivePath = sensitiveCredentialPathMatcher(plan.credentialPathRoots);
  const privateStorage = privateStorageMatcher(plan);
  try {
    await walkBounded(
      { size: manifest.length, next: 0, child: (index) => index },
      async (index) => {
        const record = manifest[index];
        if (record === undefined) return undefined;
        if (!record.staged) {
          // A link that staging resolved and skipped can become eligible through an off-tree
          // hop. Links in wholly unvisited subtrees have no resolved target to check.
          if (
            record.skippedLinkTarget !== undefined &&
            (await realpath(record.sourcePath)) !== record.skippedLinkTarget
          )
            throw new ExtensionCachePolicyMismatch();
          return undefined;
        }
        const source = record.sourcePath;
        const isLink = record.type === "symlink";
        const canonical = isLink ? await realpath(source) : source;
        const target = isLink ? sourceManifest.get(canonical) : record;
        const privateMatch = privateStorage(canonical);
        if (privateMatch === "private" || (privateMatch === "root-log" && target?.type === "file"))
          throw new ExtensionCacheRunExclusion();
        if (plan.excluded.size > 0) {
          const candidate = policyPath(canonical);
          for (const excluded of plan.excluded) {
            if (within(excluded, candidate)) throw new ExtensionCacheRunExclusion();
          }
        }
        if (target === undefined) throw new ExtensionCachePolicyMismatch();
        if (isLink) {
          if (
            within(canonical, path.dirname(source)) ||
            !plan.selectedRoots.some((root) => within(root, canonical)) ||
            isSensitivePath(source, canonical)
          )
            throw new ExtensionCachePolicyMismatch();
          const staged = path.join(payload, record.stagedRelativePath);
          const expected = path.relative(
            path.dirname(staged),
            mirroredExtensionStagePath(payload, canonical),
          );
          if ((await readlink(staged)) !== expected) throw new ExtensionCachePolicyMismatch();
        }
        if (target.type !== "file") return undefined;
        if (
          target.source.ino !== 0n &&
          (plan.privateFiles.size > 0 || plan.excludedFiles.size > 0)
        ) {
          const identity = `${target.source.dev}:${target.source.ino}`;
          if (plan.privateFiles.has(identity) || plan.excludedFiles.has(identity))
            throw new ExtensionCacheRunExclusion();
        }
        if (isRepositorySessionFile(source, canonical, plan))
          throw new ExtensionCacheRunExclusion();
        if (
          (target.source.nlink > 1n ||
            canonical.toLowerCase().endsWith(".jsonl") ||
            (isLink && source.toLowerCase().endsWith(".jsonl"))) &&
          (await isPiSessionFile(
            canonical,
            scans,
            isLink ? [source, canonical] : [source],
            Number(target.source.nlink),
          ))
        ) {
          throw new ExtensionCachePolicyMismatch();
        }
        return undefined;
      },
      signal,
    );
    return "valid";
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ExtensionCacheRunExclusion) return "run-exclusions";
    return "source-mismatch";
  }
}

/** Rechecks enabled source entry points and maps them to the staged tree. */
export async function validateExtensionSnapshot(
  plan: ExtensionSnapshotPlan,
  destination: string,
): Promise<Pick<ExtensionSnapshot, "paths" | "sourcePaths">> {
  const paths: string[] = [];
  const sourcePaths: string[] = [];
  for (const resource of plan.enabled) {
    const canonical = await realpath(resource.path);
    if (await isPrivateStorage(canonical, plan)) throw refusePrivateStorage();
    const root = plan.selectedRoots.find((candidate) => within(candidate, canonical));
    if (root === undefined)
      throw new Error(
        "[PI_EXTENSION_RUNTIME_UNSUPPORTED] An extension entry escapes its staged package directory.",
      );
    const staged = path.join(
      mirroredExtensionStagePath(destination, root),
      path.relative(root, canonical),
    );
    if (!paths.includes(staged)) {
      paths.push(staged);
      sourcePaths.push(canonical);
    }
  }
  return { paths, sourcePaths };
}

export async function snapshotExtensionResources(
  resources: readonly ExtensionResource[],
  destination: string,
  signal?: AbortSignal,
  storage?: PiRuntimeStorage,
  budget?: { readonly entries: number; readonly bytes: number },
  excludedPaths: readonly string[] = [],
): Promise<ExtensionSnapshot> {
  const plan = await planExtensionSnapshot(resources, signal, storage, excludedPaths);
  const { paths, sourcePaths, digest, entries, bytes } = await stageExtensionSnapshot(
    plan,
    destination,
    signal,
    budget,
  );
  return { paths, sourcePaths, digest, entries, bytes };
}
