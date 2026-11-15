import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  cleanupReviewRuntime,
  discoverPreparedExtensions,
  prepareReviewRuntime,
} from "./pi-extension-discovery.js";
import { preparePiExtensions } from "./pi-extension-runtime.js";

vi.mock("./pi-extension-runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pi-extension-runtime.js")>();
  return { ...original, preparePiExtensions: vi.fn(original.preparePiExtensions) };
});

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

  describe("on Windows", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.mocked(preparePiExtensions).mockClear();
    });

    it("rejects enabled-extension discovery without staging any extension tree", async () => {
      const root = await createTempDir("review-runtime-windows-");
      const agentDir = path.join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      vi.stubGlobal("process", { ...process, platform: "win32" });

      const runtime = await prepareReviewRuntime(
        ["pi"],
        agentDir,
        {},
        await createTempDir("review-runtime-windows-scratch-"),
      );
      try {
        expect(preparePiExtensions).not.toHaveBeenCalled();
        await expect(discoverPreparedExtensions(runtime)).rejects.toThrow(
          /^\[PI_EXTENSION_DISCOVERY_UNSUPPORTED\]/,
        );
      } finally {
        await cleanupReviewRuntime(runtime);
      }
    });
  });
});
