import { chmod, lstat, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { assertStableProspectiveDirectory, createStableDirectory } from "./stable-directory.js";

const { createTempDir } = registerManagedTempPaths();

describe.skipIf(process.platform === "win32")("prospective output directories (#98)", () => {
  it("checks the nearest existing folder of a path that does not exist yet", async () => {
    const root = await realpath(await createTempDir("pioneer-stable-prospective-"));
    const shared = path.join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    try {
      await expect(
        assertStableProspectiveDirectory(path.join(shared, "a", "b"), process.platform, "Label"),
      ).rejects.toThrow(/Label is writable by another user/);
    } finally {
      await chmod(shared, 0o700);
    }
    await expect(
      assertStableProspectiveDirectory(path.join(shared, "a", "b"), process.platform, "Label"),
    ).resolves.toBeUndefined();
  });

  it("requires a linked ancestor to belong to the caller, even below a sticky folder", async () => {
    const root = await realpath(await createTempDir("pioneer-stable-prospective-link-"));
    const sticky = path.join(root, "sticky");
    const target = path.join(root, "target");
    await mkdir(sticky);
    await mkdir(target);
    await chmod(sticky, 0o1777);
    const link = path.join(sticky, "link");
    await symlink(target, link);
    const ownUid = (await lstat(link)).uid;
    try {
      await expect(
        assertStableProspectiveDirectory(
          path.join(link, "later"),
          process.platform,
          "Label",
          ownUid,
        ),
      ).resolves.toBeUndefined();
      // Seen as another user's link: the sticky folder no longer protects it.
      await expect(
        assertStableProspectiveDirectory(
          path.join(link, "later"),
          process.platform,
          "Label",
          ownUid + 1,
        ),
      ).rejects.toThrow(/Label has an untrusted owner/);
    } finally {
      await chmod(sticky, 0o700);
    }
  });

  it("checks the folder that holds a linked ancestor", async () => {
    const root = await realpath(await createTempDir("pioneer-stable-prospective-holder-"));
    const shared = path.join(root, "shared");
    const target = path.join(root, "target");
    await mkdir(shared);
    await mkdir(target);
    await symlink(target, path.join(shared, "link"));
    await chmod(shared, 0o777);
    try {
      await expect(
        assertStableProspectiveDirectory(
          path.join(shared, "link", "later"),
          process.platform,
          "Label",
        ),
      ).rejects.toThrow(/Label is writable by another user/);
    } finally {
      await chmod(shared, 0o700);
    }
  });
});

describe.skipIf(process.platform === "win32")("creating output directories (#98)", () => {
  it("creates each missing folder owner-only", async () => {
    const root = await realpath(await createTempDir("pioneer-stable-create-"));
    const directory = path.join(root, "a", "b", "c");
    await createStableDirectory(directory, process.platform, "Label");
    for (const part of ["a", "a/b", "a/b/c"]) {
      const stats = await lstat(path.join(root, part));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("refuses a missing folder that appears as a link right after the check", async () => {
    const root = await realpath(await createTempDir("pioneer-stable-create-after-check-"));
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    const raced = path.join(root, "raced");
    await expect(
      createStableDirectory(path.join(raced, "logs"), process.platform, "Label", undefined, {
        afterCheck: async () => {
          await symlink(elsewhere, raced);
        },
      }),
    ).rejects.toThrow(/Label is not a stable directory/);
    await expect(lstat(path.join(elsewhere, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a missing folder that turns into a link before it is created", async () => {
    const root = await realpath(await createTempDir("pioneer-stable-create-race-"));
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    const directory = path.join(root, "raced", "logs");
    await expect(
      createStableDirectory(directory, process.platform, "Label", undefined, {
        beforeCreate: async (component) => {
          if (component === path.join(root, "raced")) await symlink(elsewhere, component);
        },
      }),
    ).rejects.toThrow(/Label is not a stable directory/);
    await expect(lstat(path.join(elsewhere, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
