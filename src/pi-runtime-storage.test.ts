import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { piRuntimeStorage } from "./pi-runtime-storage.js";

const { createTempDir } = registerManagedTempPaths();

describe("piRuntimeStorage", () => {
  it("resolves configured session directories against the Pi environment home", async () => {
    const root = await createTempDir("pi-runtime-storage-");
    const agentDir = path.join(root, "agent");
    const home = path.join(root, "pi-user-home");
    const settings = path.join(root, "settings.json");
    await writeFile(settings, JSON.stringify({ sessionDir: "~/pi-history" }));
    await expect(
      piRuntimeStorage(agentDir, settings, {
        HOME: home,
        PI_CODING_AGENT_SESSION_DIR: "~/env-history",
      }),
    ).resolves.toEqual({
      agentDir,
      sessionDirs: [path.join(home, "env-history"), path.join(home, "pi-history")],
    });
    await expect(piRuntimeStorage(agentDir, settings, {})).resolves.toEqual({
      agentDir,
      sessionDirs: [path.join(os.homedir(), "pi-history")],
    });
    const other = path.join(root, "other-home");
    const preferred = process.platform === "win32" ? other : home;
    await expect(
      piRuntimeStorage(agentDir, settings, { HOME: home, USERPROFILE: other }),
    ).resolves.toEqual({ agentDir, sessionDirs: [path.join(preferred, "pi-history")] });
  });

  it("refuses relative session directories that Pi resolves against its own working directory", async () => {
    const root = await createTempDir("pi-runtime-storage-relative-");
    const agentDir = path.join(root, "agent");
    const settings = path.join(root, "settings.json");
    await writeFile(settings, JSON.stringify({ sessionDir: "history" }));
    await expect(piRuntimeStorage(agentDir, settings, {})).rejects.toThrow(
      "[PI_SESSION_DIR_RELATIVE]",
    );
    await expect(
      piRuntimeStorage(agentDir, path.join(root, "missing.json"), {
        PI_CODING_AGENT_SESSION_DIR: "./history",
      }),
    ).rejects.toThrow("[PI_SESSION_DIR_RELATIVE]");
  });

  it("uses Pi's default storage when settings are missing or unparseable", async () => {
    const root = await createTempDir("pi-runtime-storage-default-");
    const agentDir = path.join(root, "agent");
    const settings = path.join(root, "settings.json");
    await expect(piRuntimeStorage(agentDir, settings, {})).resolves.toEqual({
      agentDir,
      sessionDirs: [],
    });
    await writeFile(settings, "{");
    await expect(piRuntimeStorage(agentDir, settings, {})).resolves.toEqual({
      agentDir,
      sessionDirs: [],
    });
    await writeFile(settings, JSON.stringify({ sessionDir: 42 }));
    await expect(piRuntimeStorage(agentDir, settings, {})).resolves.toEqual({
      agentDir,
      sessionDirs: [],
    });
  });
});
