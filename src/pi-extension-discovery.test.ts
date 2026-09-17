import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { cleanupReviewRuntime, prepareReviewRuntime } from "./pi-extension-discovery.js";

const { createTempDir } = registerManagedTempPaths();

describe("prepareReviewRuntime", () => {
  it("locates configured session storage with the Pi environment's home", async () => {
    const root = await createTempDir("review-runtime-session-home-");
    const agentDir = path.join(root, "agent");
    const skill = path.join(agentDir, "skills", "review");
    await mkdir(path.join(skill, "history"), { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "review skill");
    await writeFile(path.join(skill, "history", "private.jsonl"), "private history");
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: "~/history" }),
    );
    const piHome = process.platform === "win32" ? "USERPROFILE" : "HOME";

    const runtime = await prepareReviewRuntime(
      ["pi"],
      agentDir,
      { [piHome]: skill },
      await createTempDir("review-runtime-scratch-"),
      undefined,
      false,
    );
    try {
      await expect(
        readFile(path.join(runtime.home.agentDir, "skills", "review", "SKILL.md"), "utf8"),
      ).resolves.toBe("review skill");
      await expect(
        lstat(path.join(runtime.home.agentDir, "skills", "review", "history")),
      ).rejects.toThrow();
    } finally {
      await cleanupReviewRuntime(runtime);
    }
  });
});
