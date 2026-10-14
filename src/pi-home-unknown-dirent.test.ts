import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareIsolatedPiHome } from "./pi-home.js";

const { createTempDir } = registerManagedTempPaths();

// Some FUSE and network filesystems report DT_UNKNOWN, so every Dirent type check is false.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    opendir: async (directory: string) => {
      const names = await fs.readdir(directory);
      return (async function* () {
        for (const name of names)
          yield {
            name,
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => false,
          };
      })();
    },
  };
});

it("applies hard exclusions and the session check when directory entry types are unknown", async () => {
  const root = await createTempDir("pi-home-unknown-dirent-");
  const source = path.join(root, "agent");
  const skill = path.join(source, "skills", "review");
  const dependency = path.join(source, "node_modules", "helper");
  const header = `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`;
  for (const directory of [
    path.join(skill, "sessions"),
    path.join(skill, ".cache"),
    path.join(skill, "history"),
    path.join(dependency, ".npm"),
    path.join(dependency, "history"),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(path.join(source, "settings.json"), "{}");
  await writeFile(path.join(skill, "SKILL.md"), "review skill");
  await writeFile(path.join(skill, "sessions", "old.jsonl"), "history");
  await writeFile(path.join(skill, ".cache", "secret"), "cache");
  await writeFile(path.join(skill, "debug.log"), "log");
  await writeFile(path.join(skill, "history", "2026_a.jsonl"), header);
  await writeFile(path.join(dependency, "index.js"), "dependency");
  await writeFile(path.join(dependency, ".npm", "secret"), "npm cache");
  await writeFile(path.join(dependency, "history", "2026_b.jsonl"), header);

  const prepared = await prepareIsolatedPiHome({
    sourceDir: source,
    destination: path.join(root, "run", "pi"),
    mode: "review",
    piHomeIncludes: ["node_modules/helper"],
    environment: {},
  });

  const staged = (...parts: string[]): string => path.join(prepared.agentDir, ...parts);
  await expect(readFile(staged("skills", "review", "SKILL.md"), "utf8")).resolves.toBe(
    "review skill",
  );
  await expect(readFile(staged("node_modules", "helper", "index.js"), "utf8")).resolves.toBe(
    "dependency",
  );
  for (const excluded of [
    staged("skills", "review", "sessions"),
    staged("skills", "review", ".cache"),
    staged("skills", "review", "debug.log"),
    staged("skills", "review", "history", "2026_a.jsonl"),
    staged("node_modules", "helper", ".npm"),
    staged("node_modules", "helper", "history", "2026_b.jsonl"),
  ])
    await expect(lstat(excluded), excluded).rejects.toThrow();
});
