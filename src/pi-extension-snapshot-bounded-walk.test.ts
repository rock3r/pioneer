import { createHook } from "node:async_hooks";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { snapshotExtensionResources } from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const fake = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  entries: 0,
  lstatCalls: 0,
}));

// Make one directory look huge to the entry-count scan without creating its files. Its
// children do not exist, so each visit is one failed lstat, and the copy sees a small tree.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      fake.lstatCalls += 1;
      return actual.lstat(...args);
    },
    opendir: (...args: Parameters<typeof actual.opendir>) =>
      args[0] === fake.directory
        ? Promise.resolve({
            async *[Symbol.asyncIterator]() {
              for (let index = 0; index < fake.entries; index += 1) yield { name: `e-${index}` };
            },
            close: () => Promise.resolve(),
          })
        : actual.opendir(...args),
  };
});

afterEach(() => {
  fake.directory = undefined;
  fake.entries = 0;
  fake.lstatCalls = 0;
});

/** The largest number of promises pending at once while `run` executes. */
async function maxPendingPromises(run: () => Promise<unknown>): Promise<number> {
  const pending = new Set<number>();
  let max = 0;
  const hook = createHook({
    init(id, type) {
      if (type !== "PROMISE") return;
      pending.add(id);
      if (pending.size > max) max = pending.size;
    },
    promiseResolve(id) {
      pending.delete(id);
    },
  });
  hook.enable();
  try {
    await run();
  } finally {
    hook.disable();
  }
  return max;
}

async function extensionDirectory(): Promise<{ root: string; extension: string }> {
  const root = await createTempDir("bounded-walk-");
  const extension = path.join(root, "extensions", "reviewer");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "index.ts"), "extension");
  return { root, extension: await realpath(extension) };
}

function snapshot(root: string, extension: string, name = "snapshot"): Promise<unknown> {
  return snapshotExtensionResources(
    [{ path: path.join(extension, "index.ts"), enabled: true, metadata: { scope: "user" } }],
    path.join(root, name),
    undefined,
    { agentDir: path.join(root, "agent"), sessionDirs: [] },
  );
}

it("keeps pending work bounded while it scans a large valid directory", async () => {
  const { root, extension } = await extensionDirectory();
  fake.directory = extension;
  fake.entries = 20_000;

  const pending = await maxPendingPromises(() => snapshot(root, extension));

  // One pending task per child would hold tens of thousands of promises.
  expect(pending).toBeLessThan(2_000);
  expect(fake.lstatCalls).toBeGreaterThan(20_000);
});

it("keeps pending work bounded while it copies a large valid directory", async () => {
  const { root, extension } = await extensionDirectory();
  const lib = path.join(extension, "lib");
  await mkdir(lib);
  for (let index = 0; index < 3_000; index += 1) {
    await writeFile(path.join(lib, `file-${index}.js`), "x");
  }

  const pending = await maxPendingPromises(() => snapshot(root, extension));

  expect(pending).toBeLessThan(1_500);
});

it("counts the selected roots toward the scan limit before it visits any child", async () => {
  const { root, extension } = await extensionDirectory();
  fake.directory = extension;
  // The root itself plus 500,000 children is one entry over the limit.
  fake.entries = 500_000;

  await expect(snapshot(root, extension)).rejects.toThrow(
    /^\[PI_EXTENSION_SNAPSHOT_LIMIT\] .*more than 500000 entries to scan/u,
  );
  expect(fake.lstatCalls).toBeLessThan(1_000);
});
