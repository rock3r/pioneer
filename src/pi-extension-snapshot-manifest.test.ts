import { lstat, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import * as staging from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const race = vi.hoisted(() => ({
  source: undefined as string | undefined,
  linkRead: undefined as { source: string; replace: () => Promise<void> } | undefined,
  linkResolve: undefined as { source: string; replace: () => Promise<void> } | undefined,
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readlink: async (...args: Parameters<typeof fs.readlink>) => {
      if (race.linkRead !== undefined && args[0] === race.linkRead.source) {
        const { replace } = race.linkRead;
        race.linkRead = undefined;
        await replace();
      }
      return fs.readlink(...args);
    },
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const resolved = await fs.realpath(...args);
      if (race.linkResolve !== undefined && args[0] === race.linkResolve.source) {
        const { replace } = race.linkResolve;
        race.linkResolve = undefined;
        await replace();
      }
      return resolved;
    },
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

it("records repository-filtered JSONL files as skipped only in the relevant review", async () => {
  const { root, extension, resources, destination } = await fixture();
  const data = path.join(extension, "records.jsonl");
  await writeFile(data, '{"type":"fixture"}\n');
  const storage = { agentDir: path.join(root, "pi-agent"), sessionDirs: [] };
  const review = await staging.planExtensionSnapshot(resources, undefined, {
    ...storage,
    repositorySessionDirs: [extension],
  });
  const other = await staging.planExtensionSnapshot(resources, undefined, storage);

  const filtered = await staging.stageExtensionSnapshot(review, destination);
  const unfiltered = await staging.stageExtensionSnapshot(other, path.join(root, "other"));
  expect(filtered.manifest.find((record) => record.sourcePath === data)).toMatchObject({
    staged: false,
  });
  expect(unfiltered.manifest.find((record) => record.sourcePath === data)).toMatchObject({
    staged: true,
  });
  expect(filtered.digest).not.toBe(unfiltered.digest);
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

it.skipIf(process.platform === "win32").each(["disappears", "becomes a file"])(
  "stages successfully when an ignored metadata link %s during the prepass",
  async (change) => {
    const { extension, resources, destination } = await fixture();
    const metadata = path.join(extension, ".git");
    const alias = path.join(metadata, "alias");
    await mkdir(metadata);
    await symlink("../index.ts", alias);
    race.linkRead = {
      source: alias,
      replace: async () => {
        await unlink(alias);
        if (change === "becomes a file") await writeFile(alias, "synthetic metadata\n");
      },
    };
    try {
      const plan = await staging.planExtensionSnapshot(resources);
      const staged = await staging.stageExtensionSnapshot(plan, destination);
      const record = staged.manifest.find((entry) => entry.sourcePath === alias);
      expect(race.linkRead).toBeUndefined();
      if (change === "becomes a file") {
        expect(record).toMatchObject({
          staged: false,
          type: "file",
          source: expect.objectContaining({ ino: (await lstat(alias, { bigint: true })).ino }),
        });
        expect(record).not.toHaveProperty("linkText");
      } else {
        expect(record).toBeUndefined();
      }
    } finally {
      race.linkRead = undefined;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a selected link whose destination changes after it is first resolved",
  async () => {
    const { extension, resources, destination } = await fixture();
    const alias = path.join(extension, "alias.ts");
    await symlink("index.ts", alias);
    await writeFile(path.join(extension, "alternate.ts"), "export default 'alternate';\n");
    race.linkResolve = {
      source: alias,
      replace: async () => {
        await unlink(alias);
        await symlink("alternate.ts", alias);
      },
    };
    try {
      await expect(staging.snapshotExtensionResources(resources, destination)).rejects.toThrow(
        "[PI_EXTENSION_SNAPSHOT_CHANGED]",
      );
      expect(race.linkResolve).toBeUndefined();
    } finally {
      race.linkResolve = undefined;
    }
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
