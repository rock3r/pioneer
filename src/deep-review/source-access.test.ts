import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import {
  canonicalSourcePath,
  resolveSourceDirectoryPath,
  resolveSourceFilePath,
} from "./source-access.js";

describe("deep-review source access", () => {
  const { createTempDir } = registerManagedTempPaths();

  it("rejects repository-relative paths that escape the source root", () => {
    expect(() => canonicalSourcePath("/repo", "../secret.txt")).toThrow(/escapes source root/);
  });

  it("rejects symbolic links when reading source files", async () => {
    const root = await createTempDir("deep-review-source-access-");
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await writeFile(target, "secret\n", "utf8");
    await symlink(target, link);
    expect(() => resolveSourceFilePath(root, "link.txt")).toThrow(/Symbolic links are not allowed/);
  });

  it("rejects symbolic links when listing source directories", async () => {
    const root = await createTempDir("deep-review-source-access-dir-");
    const target = path.join(root, "dir");
    const link = path.join(root, "linkdir");
    await mkdir(target);
    await writeFile(path.join(target, "file.txt"), "x\n", "utf8");
    await symlink(target, link);
    expect(() => resolveSourceDirectoryPath(root, "linkdir")).toThrow(
      /Symbolic links are not allowed/,
    );
  });
});
