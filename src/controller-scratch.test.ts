import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  adoptCreatedScratchDirectory,
  controllerScratchSocketFailure,
  validateControllerScratchBase,
} from "./controller-scratch.js";

const { createTempDir } = registerManagedTempPaths();

describe("controller scratch base", () => {
  it("accepts a caller directory and returns its canonical path", async () => {
    const root = await createTempDir("pioneer-scratch-base-");
    const base = path.join(root, "scratch");
    await mkdir(base);

    await expect(validateControllerScratchBase(base)).resolves.toBe(
      await import("node:fs/promises").then(({ realpath }) => realpath(base)),
    );
  });

  it("rejects a relative path", async () => {
    await expect(validateControllerScratchBase("relative/scratch")).rejects.toThrow(/absolute/i);
  });

  it("rejects a path that is not a directory", async () => {
    const root = await createTempDir("pioneer-scratch-base-");
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "");

    await expect(validateControllerScratchBase(file)).rejects.toThrow(/directory/i);
  });

  it("rejects a missing directory rather than creating it", async () => {
    const root = await createTempDir("pioneer-scratch-base-");

    await expect(validateControllerScratchBase(path.join(root, "absent"))).rejects.toThrow(
      /scratch base/i,
    );
  });

  // The protected-root list is POSIX-only in `isBroadWritablePath`, and `/etc` is not a real
  // path on Windows, where such a base is refused by the existence check above instead.
  it.skipIf(process.platform === "win32")(
    "rejects a broad or protected POSIX location",
    async () => {
      await expect(validateControllerScratchBase("/etc", "linux")).rejects.toThrow(
        /broad|protected/i,
      );
    },
  );

  it("rejects a Linux base with no room for the proxy bridge socket", () => {
    expect(controllerScratchSocketFailure(`/tmp/${"d".repeat(90)}`, "linux")).toMatch(/socket/i);
  });

  it("accepts the short Linux default and leaves other platforms unbounded", () => {
    expect(controllerScratchSocketFailure("/tmp", "linux")).toBeUndefined();
    // Only Linux binds the bridge socket, so a long macOS base is not a length failure.
    expect(controllerScratchSocketFailure(`/tmp/${"d".repeat(90)}`, "darwin")).toBeUndefined();
  });

  // A base other local users can write to lets one of them swap the freshly created scratch
  // directory for a symlink between mkdtemp and realpath, redirecting the Pi credential
  // snapshot and the recursive cleanup that follows it. The sticky bit is what stops that,
  // which is why the default /tmp is safe at mode 1777.
  it.skipIf(process.platform === "win32")(
    "rejects a base other users can write to without the sticky bit",
    async () => {
      const root = await createTempDir("pioneer-scratch-base-");
      const shared = path.join(root, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);

      await expect(validateControllerScratchBase(shared)).rejects.toThrow(/sticky|other users/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts a world-writable base that carries the sticky bit",
    async () => {
      const root = await createTempDir("pioneer-scratch-base-");
      const sticky = path.join(root, "sticky");
      await mkdir(sticky);
      await chmod(sticky, 0o1777);

      await expect(validateControllerScratchBase(sticky)).resolves.toContain("sticky");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a scratch directory replaced by a symlink after creation",
    async () => {
      const base = await createTempDir("pioneer-scratch-adopt-");
      const elsewhere = await createTempDir("pioneer-scratch-victim-");
      const created = path.join(base, "pioneer-eval-control-fixture");
      await symlink(elsewhere, created);

      await expect(adoptCreatedScratchDirectory(created)).rejects.toThrow(/replaced/i);
    },
  );

  it("adopts a genuine scratch directory unchanged", async () => {
    const base = await createTempDir("pioneer-scratch-adopt-");
    const created = path.join(base, "pioneer-eval-control-fixture");
    await mkdir(created);

    const { realpath } = await import("node:fs/promises");
    await expect(adoptCreatedScratchDirectory(created)).resolves.toBe(await realpath(created));
  });
});
