import { link, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareIsolatedPiHome } from "./pi-home.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({ source: undefined as string | undefined }));

// The selection check passes, then the chosen file gains a Pi session header during its copy.
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
      await fs.writeFile(destination, header.padEnd(Math.max(size, header.length), " "));
    },
  };
});

afterEach(() => {
  race.source = undefined;
});

async function piHome(): Promise<{ root: string; source: string; skill: string }> {
  const root = await createTempDir("pi-home-session-copy-");
  const source = path.join(root, "agent");
  const skill = path.join(source, "skills", "review");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(source, "settings.json"), "{}");
  await writeFile(path.join(skill, "SKILL.md"), "review skill");
  return { root, source, skill };
}

it("refuses a .jsonl file that became Pi session history while it was copied", async () => {
  const { root, source, skill } = await piHome();
  await writeFile(path.join(skill, "dataset.jsonl"), `${'{"type":"example"}\n'.repeat(4)}`);
  race.source = "dataset.jsonl";

  await expect(
    prepareIsolatedPiHome({
      sourceDir: source,
      destination: path.join(root, "run", "pi"),
      mode: "review",
      environment: {},
    }),
  ).rejects.toThrow(
    /\[PI_HOME_SNAPSHOT_CHANGED\] Pi home file skills\/review\/dataset\.jsonl was replaced or became Pi session history/u,
  );
});

it("checks a hard-linked file's copy by the source's link count", async () => {
  const { root, source, skill } = await piHome();
  const outside = path.join(root, "notes-elsewhere.txt");
  await writeFile(outside, "plain notes that are long enough to hold a session header\n");
  await link(outside, path.join(skill, "notes.txt"));
  race.source = "notes.txt";

  await expect(
    prepareIsolatedPiHome({
      sourceDir: source,
      destination: path.join(root, "run", "pi"),
      mode: "review",
      environment: {},
    }),
  ).rejects.toThrow(
    /\[PI_HOME_SNAPSHOT_CHANGED\] Pi home file skills\/review\/notes\.txt was replaced or became Pi session history/u,
  );
});
