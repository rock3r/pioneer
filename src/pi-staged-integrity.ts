import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

// One Pi-home snapshot and one combined extension snapshot, with room for their
// controller-generated launch files and directories.
const MAX_ENTRIES = 1_001_024;
const MAX_BYTES = 2 * 1024 ** 3 + 16 * 1024 ** 2;
const MUTABLE_AGENT_FILES = new Set(["auth.json", "settings.json", "models-store.json"]);

export class PiStagedIntegrityError extends Error {
  constructor() {
    super(
      "[PI_STAGED_INTEGRITY_FAILED] Pioneer could not verify the integrity of staged Pi inputs",
    );
  }
}

interface PiStagedIntegrityInputs {
  readonly agentDir?: string;
  readonly extensionRoot?: string;
  readonly controllerFiles?: readonly string[];
  readonly checkAborted?: () => void;
}

type StagedEntry =
  | { readonly file: string; readonly stats: Stats; readonly kind: "file"; readonly digest: string }
  | { readonly file: string; readonly stats: Stats; readonly kind: "link"; readonly target: string }
  | {
      readonly file: string;
      readonly stats: Stats;
      readonly kind: "directory";
      readonly children?: ReadonlySet<string>;
    };

function sameIdentity(expected: Stats, actual: Stats): boolean {
  return (
    expected.dev === actual.dev && expected.ino === actual.ino && expected.mode === actual.mode
  );
}

function assertRegularFile(expected: Stats, actual: Stats): void {
  if (
    !actual.isFile() ||
    actual.nlink !== 1 ||
    !sameIdentity(expected, actual) ||
    expected.size !== actual.size
  ) {
    throw new PiStagedIntegrityError();
  }
}

async function fileDigest(
  file: string,
  expected: Stats,
  buffer: Buffer,
  checkAborted?: () => void,
): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    // Verify the original staged inode before reading any bytes.
    assertRegularFile(expected, before);
    const hash = createHash("sha256");
    for (let offset = 0; offset < expected.size; ) {
      checkAborted?.();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size - offset),
        offset,
      );
      if (bytesRead === 0) throw new PiStagedIntegrityError();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    assertRegularFile(before, after);
    assertRegularFile(before, await lstat(file));
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new PiStagedIntegrityError();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function prepareStagedVerification(
  inputs: PiStagedIntegrityInputs,
): Promise<() => Promise<void>> {
  const ancestors = new Map<string, Stats>();
  const entries: StagedEntry[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let entryCount = 0;
  let bytes = 0;

  const countEntry = (): void => {
    inputs.checkAborted?.();
    entryCount += 1;
    if (entryCount > MAX_ENTRIES) throw new PiStagedIntegrityError();
  };
  const canonicalRoot = async (file: string): Promise<string> => {
    if ((await lstat(file)).isSymbolicLink()) throw new PiStagedIntegrityError();
    const canonical = await realpath(file);
    const parents: string[] = [];
    let parent = path.dirname(canonical);
    while (!ancestors.has(parent)) {
      parents.push(parent);
      if (parent === path.dirname(parent)) break;
      parent = path.dirname(parent);
    }
    for (const directory of parents.reverse()) {
      const stats = await lstat(directory);
      if (!stats.isDirectory()) throw new PiStagedIntegrityError();
      ancestors.set(directory, stats);
    }
    countEntry();
    return canonical;
  };
  const capture = async (file: string, mutableAgentRoot = false): Promise<void> => {
    const stats = await lstat(file);
    if (stats.isDirectory()) {
      const children = new Set<string>();
      for await (const entry of await opendir(file)) {
        countEntry();
        if (!mutableAgentRoot || !MUTABLE_AGENT_FILES.has(entry.name)) children.add(entry.name);
      }
      entries.push({
        file,
        stats,
        kind: "directory",
        ...(mutableAgentRoot ? {} : { children }),
      });
      for (const name of children) await capture(path.join(file, name));
    } else if (stats.isSymbolicLink()) {
      // Staged extension dependencies can use links. Read the link, never its target.
      entries.push({ file, stats, kind: "link", target: await readlink(file) });
    } else {
      assertRegularFile(stats, stats);
      bytes += stats.size;
      if (bytes > MAX_BYTES) throw new PiStagedIntegrityError();
      const digest = await fileDigest(file, stats, buffer, inputs.checkAborted);
      entries.push({ file, stats, kind: "file", digest });
    }
  };

  if (inputs.agentDir !== undefined) await capture(await canonicalRoot(inputs.agentDir), true);
  if (inputs.extensionRoot !== undefined) await capture(await canonicalRoot(inputs.extensionRoot));
  for (const file of inputs.controllerFiles ?? []) await capture(await canonicalRoot(file));

  return async () => {
    // Check the captured ancestors top-down. Descendant checks then follow the
    // controller's pre-order record of exact paths, never a post-run filename.
    for (const [directory, expected] of ancestors) {
      const actual = await lstat(directory);
      if (!actual.isDirectory() || !sameIdentity(expected, actual))
        throw new PiStagedIntegrityError();
    }
    for (const entry of entries) {
      const actual = await lstat(entry.file);
      if (!sameIdentity(entry.stats, actual)) throw new PiStagedIntegrityError();
      if (entry.kind === "file") {
        if ((await fileDigest(entry.file, entry.stats, buffer)) !== entry.digest)
          throw new PiStagedIntegrityError();
      } else if (entry.kind === "link") {
        if ((await readlink(entry.file)) !== entry.target) throw new PiStagedIntegrityError();
      } else if (entry.children !== undefined) {
        let count = 0;
        for await (const child of await opendir(entry.file)) {
          count += 1;
          if (!entry.children.has(child.name) || count > entry.children.size)
            throw new PiStagedIntegrityError();
        }
        if (count !== entry.children.size) throw new PiStagedIntegrityError();
      }
    }
  };
}

export async function withPiStagedIntegrity<T>(
  inputs: PiStagedIntegrityInputs,
  run: () => Promise<T>,
): Promise<T> {
  let verify: () => Promise<void>;
  try {
    verify = await prepareStagedVerification(inputs);
  } catch {
    inputs.checkAborted?.();
    throw new PiStagedIntegrityError();
  }
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await run() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await verify();
  } catch {
    throw new PiStagedIntegrityError();
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
