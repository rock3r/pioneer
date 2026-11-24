import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { withPiStagedIntegrity } from "./pi-staged-integrity.js";

const { createTempDir } = registerManagedTempPaths();

async function stagedFixture(): Promise<{ agentDir: string; extensionRoot: string }> {
  const root = await createTempDir("pioneer-test-integrity-");
  const agentDir = path.join(root, "agent");
  const extensionRoot = path.join(root, "extensions");
  await Promise.all([mkdir(agentDir), mkdir(extensionRoot)]);
  await Promise.all([
    writeFile(path.join(agentDir, "auth.json"), "{}"),
    writeFile(path.join(agentDir, "settings.json"), "{}"),
    writeFile(path.join(agentDir, "models.json"), "{}"),
    writeFile(path.join(extensionRoot, "entry.mjs"), "export default 1;"),
  ]);
  return { agentDir, extensionRoot };
}

describe("staged Pi integrity", () => {
  it("permits private auth and settings changes and transient files in the agent root", async () => {
    const inputs = await stagedFixture();
    await expect(
      withPiStagedIntegrity(inputs, async () => {
        await writeFile(path.join(inputs.agentDir, "auth.json"), '{"fake":{}}');
        await writeFile(path.join(inputs.agentDir, "settings.json"), '{"fake":true}');
        await writeFile(path.join(inputs.agentDir, "cache.tmp"), "transient");
        return "actor completed";
      }),
    ).resolves.toBe("actor completed");
  });

  it.each([
    ["agentDir", "models.json"],
    ["extensionRoot", "entry.mjs"],
    ["extensionRoot", "additional.mjs"],
  ] as const)("reports altered staged %s content even when the actor fails", async (root, name) => {
    const inputs = await stagedFixture();
    await expect(
      withPiStagedIntegrity(inputs, async () => {
        await writeFile(path.join(inputs[root], name), "fixture change");
        throw new Error("ordinary actor exit failure");
      }),
    ).rejects.toThrow("[PI_STAGED_INTEGRITY_FAILED]");
  });

  it("checks file content even when the inode and byte count remain the same", async () => {
    const inputs = await stagedFixture();
    await expect(
      withPiStagedIntegrity(inputs, async () => {
        await writeFile(path.join(inputs.agentDir, "models.json"), "[]");
      }),
    ).rejects.toThrow("[PI_STAGED_INTEGRITY_FAILED]");
  });

  it("rejects a changed parent identity without following links outside the staged root", async () => {
    const inputs = await stagedFixture();
    const other = await createTempDir("pioneer-test-integrity-other-");
    await writeFile(path.join(other, "entry.mjs"), "export default 1;");
    await expect(
      withPiStagedIntegrity(inputs, async () => {
        await rename(inputs.extensionRoot, `${inputs.extensionRoot}-original`);
        await symlink(other, inputs.extensionRoot, "junction");
      }),
    ).rejects.toThrow("[PI_STAGED_INTEGRITY_FAILED]");
  });
});
