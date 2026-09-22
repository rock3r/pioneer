import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { confirmReusedExtension } from "./runner.js";

const { createTempDir } = registerManagedTempPaths();

describe("reused explicit extensions", () => {
  it("accepts an unchanged regular file that is already staged", async () => {
    const root = await createTempDir("pioneer-extension-reuse-");
    const agent = path.join(root, "agent");
    const source = path.join(root, "ext", "provider.mjs");
    const staged = path.join(root, "staged", "provider.mjs");
    await mkdir(agent);
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(source, "export {}\n");
    await writeFile(staged, "export {}\n");

    await expect(confirmReusedExtension(source, staged, agent)).resolves.toBeUndefined();
  });

  it("rejects a source that was removed or replaced after staging", async () => {
    const root = await createTempDir("pioneer-extension-reuse-removed-");
    const agent = path.join(root, "agent");
    const source = path.join(root, "ext", "provider.mjs");
    const staged = path.join(root, "staged", "provider.mjs");
    await mkdir(agent);
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(source, "export {}\n");
    await writeFile(staged, "export {}\n");
    await rm(source);
    await mkdir(source);

    await expect(confirmReusedExtension(source, staged, agent)).rejects.toThrow(
      "Explicit Pi extension must be a regular file",
    );
  });

  it("rejects a source that disappeared after staging", async () => {
    const root = await createTempDir("pioneer-extension-reuse-missing-");
    const agent = path.join(root, "agent");
    const source = path.join(root, "ext", "provider.mjs");
    const staged = path.join(root, "staged", "provider.mjs");
    await mkdir(agent);
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(source, "export {}\n");
    await writeFile(staged, "export {}\n");
    await rm(source);

    await expect(confirmReusedExtension(source, staged, agent)).rejects.toThrow(
      "Explicit Pi extension could not be staged",
    );
  });

  it("rejects a source whose bytes changed after staging", async () => {
    const root = await createTempDir("pioneer-extension-reuse-changed-");
    const agent = path.join(root, "agent");
    const source = path.join(root, "ext", "provider.mjs");
    const staged = path.join(root, "staged", "provider.mjs");
    await mkdir(agent);
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(source, "export const changed = true;\n");
    await writeFile(staged, "export {}\n");

    await expect(confirmReusedExtension(source, staged, agent)).rejects.toThrow(
      "[PI_EXTENSION_SNAPSHOT_CHANGED]",
    );
  });
});
