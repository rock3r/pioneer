import { lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import * as staging from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({ source: undefined as string | undefined }));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args);
      if (args[0] === race.source) {
        race.source = undefined;
        await fs.chmod(args[0], 0o700);
      }
    },
  };
});

async function fixture() {
  const root = await realpath(await createTempDir("extension-manifest-"));
  const extension = path.join(root, "extension");
  const entry = path.join(extension, "index.ts");
  await mkdir(extension);
  await writeFile(entry, "export default () => {};\n", { mode: 0o600 });
  const resources = [{ path: entry, enabled: true, metadata: { scope: "user" } }];
  return { root, extension, entry, resources, destination: path.join(root, "snapshot") };
}

it("plans without writing and stages a controller-only record for every observed entry", async () => {
  const { root, extension, entry, resources, destination } = await fixture();
  const metadata = path.join(extension, ".git");
  const config = path.join(metadata, "config");
  const credential = path.join(extension, ".npmrc");
  const privateDirectory = path.join(extension, "private-sessions");
  const privateSession = path.join(privateDirectory, "session.txt");
  await mkdir(metadata);
  await mkdir(privateDirectory);
  await writeFile(config, "synthetic Git configuration\n");
  await writeFile(credential, "synthetic npm configuration\n");
  await writeFile(privateSession, "synthetic session file\n");
  const storage = { agentDir: path.join(root, "pi-agent"), sessionDirs: [privateDirectory] };

  const plan = await staging.planExtensionSnapshot(resources, undefined, storage);
  expect(plan.selectedRoots).toEqual([extension]);
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });

  const staged = await staging.stageExtensionSnapshot(plan, destination);
  const manifest = new Map(staged.manifest.map((record) => [record.sourcePath, record]));
  expect(manifest.size).toBe(staged.manifest.length);
  expect([...manifest.keys()].sort()).toEqual(
    [extension, entry, metadata, config, credential, privateDirectory, privateSession].sort(),
  );
  for (const skipped of [metadata, config, credential, privateDirectory, privateSession]) {
    expect(manifest.get(skipped)).toMatchObject({
      staged: false,
      source: expect.objectContaining({ ino: (await lstat(skipped, { bigint: true })).ino }),
    });
    expect(manifest.get(skipped)).not.toHaveProperty("stagedRelativePath");
    expect(manifest.get(skipped)).not.toHaveProperty("stagedMetadata");
  }
  for (const sourcePath of [extension, entry]) {
    const stagedPath = staging.mirroredExtensionStagePath(destination, sourcePath);
    const stagedRelativePath = path.relative(destination, stagedPath);
    const sourceStats = await lstat(sourcePath, { bigint: true });
    const stagedStats = await lstat(stagedPath, { bigint: true });
    const { dev, ino, size, mode, mtimeNs, ctimeNs, nlink } = sourceStats;
    expect(manifest.get(sourcePath)).toMatchObject({
      type: sourcePath === extension ? "directory" : "file",
      source: { dev, ino, size, mode, mtimeNs, ctimeNs, nlink },
      staged: true,
      stagedRelativePath,
      stagedMetadata: {
        ino: stagedStats.ino,
        size: stagedStats.size,
        mode: stagedStats.mode,
        mtimeNs: stagedStats.mtimeNs,
        ctimeNs: stagedStats.ctimeNs,
      },
    });
  }
  const normal = await staging.snapshotExtensionResources(
    resources,
    path.join(root, "public-snapshot"),
    undefined,
    storage,
  );
  expect(normal).not.toHaveProperty("manifest");
});

it.skipIf(process.platform === "win32")(
  "records a link's own canonical location, metadata, and original text",
  async () => {
    const { extension, entry, resources, destination } = await fixture();
    const alias = path.join(extension, "alias.ts");
    await symlink("./index.ts", alias);

    const plan = await staging.planExtensionSnapshot(resources);
    const staged = await staging.stageExtensionSnapshot(plan, destination);
    expect(staged.manifest.find((record) => record.sourcePath === alias)).toMatchObject({
      staged: true,
      type: "symlink",
      linkText: "./index.ts",
      source: expect.objectContaining({ ino: (await lstat(alias, { bigint: true })).ino }),
    });
    expect(staged.manifest.find((record) => record.sourcePath === entry)?.type).toBe("file");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a chmod during copy even when inode, content, size, and mtime are unchanged",
  async () => {
    const { entry, resources, destination } = await fixture();
    const before = await lstat(entry, { bigint: true });
    race.source = entry;
    try {
      await expect(staging.snapshotExtensionResources(resources, destination)).rejects.toThrow(
        "[PI_EXTENSION_SNAPSHOT_CHANGED]",
      );
      const after = await lstat(entry, { bigint: true });
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
    } finally {
      race.source = undefined;
    }
  },
);
