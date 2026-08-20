import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
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

  it("rejects a broad or protected system location", async () => {
    await expect(validateControllerScratchBase("/etc", "linux")).rejects.toThrow(
      /broad|protected/i,
    );
  });

  it("rejects a Linux base with no room for the proxy bridge socket", () => {
    expect(controllerScratchSocketFailure(`/tmp/${"d".repeat(90)}`, "linux")).toMatch(/socket/i);
  });

  it("accepts the short Linux default and leaves other platforms unbounded", () => {
    expect(controllerScratchSocketFailure("/tmp", "linux")).toBeUndefined();
    // Only Linux binds the bridge socket, so a long macOS base is not a length failure.
    expect(controllerScratchSocketFailure(`/tmp/${"d".repeat(90)}`, "darwin")).toBeUndefined();
  });
});
