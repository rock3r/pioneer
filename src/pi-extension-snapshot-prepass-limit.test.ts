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
  readNames: 0,
}));

// Make one directory look huge without creating half a million files.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const names = (): string[] =>
    Array.from({ length: fake.entries }, (_, index) => `entry-${index}`);
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      fake.lstatCalls += 1;
      return actual.lstat(...args);
    },
    readdir: (...args: Parameters<typeof actual.readdir>) =>
      args[0] === fake.directory ? Promise.resolve(names()) : actual.readdir(...args),
    opendir: (...args: Parameters<typeof actual.opendir>) =>
      args[0] === fake.directory
        ? Promise.resolve({
            async *[Symbol.asyncIterator]() {
              for (const name of names()) {
                fake.readNames += 1;
                yield { name };
              }
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
  fake.readNames = 0;
});

it("rejects an oversized directory before it queues work for its children", async () => {
  const root = await createTempDir("prepass-limit-");
  const extension = path.join(root, "extensions", "reviewer");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "index.ts"), "extension");
  fake.directory = await realpath(extension);
  fake.entries = 600_000;

  await expect(
    snapshotExtensionResources(
      [{ path: path.join(extension, "index.ts"), enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
      undefined,
      { agentDir: path.join(root, "agent"), sessionDirs: [] },
    ),
  ).rejects.toThrow(/^\[PI_EXTENSION_SNAPSHOT_LIMIT\] .*more than 500000 entries to scan/u);

  // No child was visited, and the directory read stopped once it passed the limit.
  expect(fake.lstatCalls).toBeLessThan(1_000);
  expect(fake.readNames).toBeLessThanOrEqual(500_001);
});
