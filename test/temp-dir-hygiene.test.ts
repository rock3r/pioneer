import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const unitTestRoot = path.join(repositoryRoot, "src");

async function unitTestFiles(): Promise<string[]> {
  const entries = await readdir(unitTestRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.relative(repositoryRoot, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe("unit suite temporary directories", () => {
  it("creates every temporary directory through the managed helper", async () => {
    const files = await unitTestFiles();
    expect(files.length).toBeGreaterThan(0);

    const unmanaged: string[] = [];
    for (const file of files) {
      const contents = await readFile(path.join(repositoryRoot, file), "utf8");
      if (contents.includes("mkdtemp(")) unmanaged.push(file);
    }

    expect(unmanaged).toEqual([]);
  });
});
