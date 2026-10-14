import { link, mkdir, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareIsolatedPiHome } from "./pi-home.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({
  before: undefined as undefined | { readonly file: string; readonly run: () => Promise<void> },
  after: undefined as
    | undefined
    | { readonly file: string; readonly run: (copy: string) => Promise<void> },
}));

// Change the Pi home just before or just after a copy, which real timing cannot do reliably.
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

// Keep the copy's size, so only the session check can tell that its bytes changed.
async function becomeSession(copy: string): Promise<void> {
  await writeFile(copy, header.padEnd((await stat(copy)).size, " "));
}

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

it("refuses a .jsonl file whose copy gains a session header", async () => {
  const { root, source, skill } = await piHome();
  const dataset = path.join(skill, "dataset.jsonl");
  await writeFile(dataset, '{"type":"example"}\n'.repeat(4));
  race.after = { file: dataset, run: becomeSession };

  await expect(prepare(root, source)).rejects.toThrow(
    "[PI_HOME_SNAPSHOT_CHANGED] Pi home file skills/review/dataset.jsonl was replaced or became Pi session history",
  );
  expect(race.after).toBeUndefined();
});

it("checks the copy of a hard-linked file by the source's link count", async () => {
  const { root, source, skill } = await piHome();
  const outside = path.join(root, "notes-elsewhere.txt");
  await writeFile(outside, "plain notes that are long enough to hold a session header\n");
  const notes = path.join(skill, "notes.txt");
  await link(outside, notes);
  race.after = { file: notes, run: becomeSession };

  await expect(prepare(root, source)).rejects.toThrow(
    "[PI_HOME_SNAPSHOT_CHANGED] Pi home file skills/review/notes.txt was replaced or became Pi session history",
  );
  expect(race.after).toBeUndefined();
});
