import { link, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { snapshotExtensionResources } from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({
  before: undefined as undefined | { readonly file: string; readonly run: () => Promise<void> },
}));

// Change a selected file's links just before it is copied, which real timing cannot do reliably.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      const before = race.before;
      if (before !== undefined && args[0] === before.file) {
        race.before = undefined;
        await before.run();
      }
      return await fs.copyFile(...args);
    },
  };
});

it("refuses a file that gains a .jsonl hard link while it is being copied", async () => {
  const root = await createTempDir("extension-copy-race-");
  const extension = path.join(root, "extensions", "reviewer");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "index.ts"), "extension");
  const notes = path.join(extension, "notes.txt");
  await writeFile(notes, `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`);
  race.before = {
    file: await realpath(notes),
    run: async () => {
      await link(notes, path.join(root, "2026_a.jsonl"));
    },
  };

  await expect(
    snapshotExtensionResources(
      [{ path: path.join(extension, "index.ts"), enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
      undefined,
      { agentDir: path.join(root, "agent"), sessionDirs: [] },
    ),
  ).rejects.toThrow("[PI_EXTENSION_SNAPSHOT_CHANGED]");
  expect(race.before).toBeUndefined();
});
