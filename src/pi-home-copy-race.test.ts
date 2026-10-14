import { link, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareIsolatedPiHome } from "./pi-home.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({
  before: undefined as undefined | { readonly file: string; readonly run: () => Promise<void> },
}));

// Change the Pi home between selection and copy, which real timing cannot do reliably.
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

const header = `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`;

async function piHome(): Promise<{ root: string; source: string; skill: string }> {
  const root = await createTempDir("pi-home-copy-race-");
  const source = path.join(root, "agent");
  const skill = path.join(source, "skills", "review");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(source, "settings.json"), "{}");
  return {
    root,
    source: await realpath(source),
    skill: path.join(await realpath(source), "skills", "review"),
  };
}

function prepare(root: string, source: string): Promise<unknown> {
  return prepareIsolatedPiHome({
    sourceDir: source,
    destination: path.join(root, "run", "pi"),
    mode: "review",
    environment: {},
  });
}

it("refuses a selected file that is replaced by session history before it is copied", async () => {
  const { root, source, skill } = await piHome();
  await mkdir(path.join(root, "history"));
  const history = path.join(root, "history", "2026_a.jsonl");
  await writeFile(history, header);
  const notes = path.join(skill, "notes.txt");
  await writeFile(notes, "notes");
  race.before = {
    file: notes,
    run: async () => {
      await unlink(notes);
      await link(history, notes);
    },
  };

  await expect(prepare(root, source)).rejects.toThrow("[PI_HOME_SNAPSHOT_CHANGED]");
  expect(race.before).toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "refuses a .jsonl link repointed to a session file after validation",
  async () => {
    const { root, source, skill } = await piHome();
    await writeFile(path.join(skill, "safe.txt"), "safe");
    await writeFile(path.join(skill, "notes.txt"), header);
    const latest = path.join(skill, "latest.jsonl");
    await symlink("safe.txt", latest);
    race.before = {
      file: path.join(source, "settings.json"),
      run: async () => {
        await unlink(latest);
        await symlink("notes.txt", latest);
      },
    };

    await expect(prepare(root, source)).rejects.toThrow("[PI_HOME_SNAPSHOT_CHANGED]");
    expect(race.before).toBeUndefined();
  },
);
