import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "./support/temp-dir.js";
import { createTestTempRoot } from "./support/temp-root.js";

const { createTempDir } = registerManagedTempPaths();

/**
 * Builds a parent long enough that `<parent>/pio-XXXXXX` cannot leave the Unix socket
 * reserve, whatever the operator's temporary directory happens to be.
 */
async function overlongParent(): Promise<string> {
  const base = await createTempDir("pio-root-");
  const padding = Math.max(1, 80 - Buffer.byteLength(base) - 1);
  const parent = path.join(base, "d".repeat(padding));
  await mkdir(parent, { recursive: true });
  return parent;
}

describe("run-scoped test temporary root", () => {
  it("rejects a root that cannot hold the Unix socket paths the suite binds", async () => {
    const parent = await overlongParent();

    await expect(createTestTempRoot({ parentDir: parent, platform: "linux" })).rejects.toThrow(
      "bytes for Unix socket paths",
    );
  });

  it("removes the root it created before reporting that it is too long", async () => {
    const parent = await overlongParent();

    await expect(createTestTempRoot({ parentDir: parent, platform: "linux" })).rejects.toThrow();

    expect(await readdir(parent)).toEqual([]);
  });

  it("does not apply the Unix socket budget on Windows", async () => {
    const parent = await overlongParent();

    const root = await createTestTempRoot({ parentDir: parent, platform: "win32" });

    expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root).startsWith("pio-")).toBe(true);
  });
});
