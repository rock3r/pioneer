import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareIsolatedPiHome } from "./pi-home.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({
  replace: undefined as undefined | { readonly file: string; readonly with: string },
}));

// Replace a selected file between selection and copy, which real timing cannot do reliably.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      const replace = race.replace;
      if (replace !== undefined && args[0] === replace.file) {
        race.replace = undefined;
        await fs.unlink(replace.file);
        await fs.link(replace.with, replace.file);
      }
      return await fs.copyFile(...args);
    },
  };
});

it("refuses a selected file that is replaced by session history before it is copied", async () => {
  const root = await createTempDir("pi-home-copy-race-");
  const source = path.join(root, "agent");
  const skill = path.join(source, "skills", "review");
  await mkdir(skill, { recursive: true });
  await mkdir(path.join(root, "history"));
  const history = path.join(root, "history", "2026_a.jsonl");
  await writeFile(history, `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`);
  await writeFile(path.join(skill, "notes.txt"), "notes");
  race.replace = {
    file: path.join(await realpath(source), "skills", "review", "notes.txt"),
    with: history,
  };

  await expect(
    prepareIsolatedPiHome({
      sourceDir: source,
      destination: path.join(root, "run", "pi"),
      mode: "review",
      environment: {},
    }),
  ).rejects.toThrow("[PI_HOME_SNAPSHOT_CHANGED]");
  expect(race.replace).toBeUndefined();
});
