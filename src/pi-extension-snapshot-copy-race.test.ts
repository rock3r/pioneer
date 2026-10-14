import { link, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { snapshotExtensionResources } from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({
  before: undefined as undefined | { readonly file: string; readonly run: () => Promise<void> },
  after: undefined as
    | undefined
    | { readonly file: string; readonly run: (copy: string) => Promise<void> },
}));

// Change a selected file just before or just after its copy, which real timing cannot do reliably.
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
      await fs.copyFile(...args);
      const after = race.after;
      if (after !== undefined && args[0] === after.file) {
        race.after = undefined;
        await after.run(String(args[1]));
      }
    },
  };
});

const header = `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`;

// Keep the copy's size, so the size checks pass and only the session check can fire.
async function becomeSession(copy: string): Promise<void> {
  await writeFile(copy, header.padEnd((await stat(copy)).size, " "));
}

async function extensionDirectory(): Promise<{ root: string; extension: string }> {
  const root = await createTempDir("extension-copy-race-");
  const extension = path.join(root, "extensions", "reviewer");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "index.ts"), "extension");
  return { root, extension: await realpath(extension) };
}

function snapshot(root: string, extension: string): Promise<unknown> {
  return snapshotExtensionResources(
    [{ path: path.join(extension, "index.ts"), enabled: true, metadata: { scope: "user" } }],
    path.join(root, "snapshot"),
    undefined,
    { agentDir: path.join(root, "agent"), sessionDirs: [] },
  );
}

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

it("refuses a .jsonl file whose copy gains a session header", async () => {
  const { root, extension } = await extensionDirectory();
  const fixtures = path.join(extension, "fixtures.jsonl");
  await writeFile(fixtures, '{"type":"example"}\n'.repeat(4));
  race.after = { file: fixtures, run: becomeSession };

  await expect(snapshot(root, extension)).rejects.toThrow(
    "[PI_EXTENSION_SNAPSHOT_CHANGED] A file became Pi session history while it was being copied; retry.",
  );
  expect(race.after).toBeUndefined();
});

it("checks the copy of a hard-linked file by the source's link count", async () => {
  const { root, extension } = await extensionDirectory();
  // The snapshot accepts a hard link only when every link sits inside the selected roots.
  await mkdir(path.join(extension, "data"));
  const notes = path.join(extension, "data", "notes.txt");
  await writeFile(notes, "plain notes that are long enough to hold a session header\n");
  await link(notes, path.join(extension, "notes-alias.txt"));
  race.after = { file: notes, run: becomeSession };

  await expect(snapshot(root, extension)).rejects.toThrow(
    "[PI_EXTENSION_SNAPSHOT_CHANGED] A file became Pi session history while it was being copied; retry.",
  );
  expect(race.after).toBeUndefined();
});
