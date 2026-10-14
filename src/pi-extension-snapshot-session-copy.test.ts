import { link, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { snapshotExtensionResources } from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({ source: undefined as string | undefined }));

// The selection check passes, then the chosen file gains a Pi session header during its copy.
// The copy keeps the source size, so the earlier size check passes and the session guard fires.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args);
      const [source, destination] = args;
      if (race.source === undefined || path.basename(String(source)) !== race.source) return;
      const header = `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`;
      const { size } = await fs.stat(source);
      if (size < header.length) throw new Error("The race fixture is shorter than the header");
      await fs.writeFile(destination, header.padEnd(size, " "));
    },
  };
});

afterEach(() => {
  race.source = undefined;
});

async function snapshot(root: string, extension: string): Promise<unknown> {
  return await snapshotExtensionResources(
    [{ path: path.join(extension, "index.ts"), enabled: true, metadata: { scope: "user" } }],
    path.join(root, "snapshot"),
    undefined,
    { agentDir: path.join(root, "agent"), sessionDirs: [] },
  );
}

async function extensionDirectory(): Promise<{ root: string; extension: string }> {
  const root = await createTempDir("extension-session-copy-");
  const extension = path.join(root, "extensions", "reviewer");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "index.ts"), "extension");
  return { root, extension };
}

it("refuses a .jsonl file that became Pi session history while it was copied", async () => {
  const { root, extension } = await extensionDirectory();
  await writeFile(path.join(extension, "fixtures.jsonl"), '{"type":"example"}\n'.repeat(4));
  race.source = "fixtures.jsonl";

  await expect(snapshot(root, extension)).rejects.toThrow(
    "[PI_EXTENSION_SNAPSHOT_CHANGED] A file became Pi session history while it was being copied; retry.",
  );
});

it("checks a hard-linked file's copy by the source's link count", async () => {
  const { root, extension } = await extensionDirectory();
  // The snapshot accepts a hard link only when every link sits inside the selected roots.
  await mkdir(path.join(extension, "data"));
  await writeFile(
    path.join(extension, "data", "notes.txt"),
    "plain notes that are long enough to hold a session header\n",
  );
  await link(path.join(extension, "data", "notes.txt"), path.join(extension, "notes-alias.txt"));
  race.source = "notes.txt";

  await expect(snapshot(root, extension)).rejects.toThrow(
    "[PI_EXTENSION_SNAPSHOT_CHANGED] A file became Pi session history while it was being copied; retry.",
  );
});
