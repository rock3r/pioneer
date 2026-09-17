import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

  it("normalizes file URLs like Pi", async () => {
    const root = await createTempDir("pi-runtime-storage-file-url-");
    const agentDir = path.join(root, "agent");
    const history = path.join(root, "history");
    await expect(
      piRuntimeStorage(agentDir, path.join(root, "missing.json"), {
        PI_CODING_AGENT_SESSION_DIR: pathToFileURL(history).href,
      }),
    ).resolves.toEqual({ agentDir, sessionDirs: [history] });
  });

  it.runIf(process.platform === "win32")(
    "normalizes Git Bash and WSL drive paths like Pi on Windows",
    async () => {
      const root = await createTempDir("pi-runtime-storage-shell-path-");
      await expect(
        piRuntimeStorage(path.join(root, "agent"), path.join(root, "missing.json"), {
          PI_CODING_AGENT_SESSION_DIR: "/c/Users/pi/sessions",
        }),
      ).resolves.toMatchObject({ sessionDirs: ["C:\\Users\\pi\\sessions"] });
      await expect(
        piRuntimeStorage(path.join(root, "agent"), path.join(root, "missing.json"), {
          PI_CODING_AGENT_SESSION_DIR: "/mnt/d/pi",
        }),
      ).resolves.toMatchObject({ sessionDirs: ["D:\\pi"] });
      const nonAscii = await piRuntimeStorage(
        path.join(root, "agent"),
        path.join(root, "missing.json"),
        { PI_CODING_AGENT_SESSION_DIR: "/\u017f/private" },
      );
      expect(nonAscii.sessionDirs).toEqual([path.resolve("/\u017f/private")]);
      await expect(
        piRuntimeStorage(path.join(root, "agent"), path.join(root, "missing.json"), {
          PI_CODING_AGENT_SESSION_DIR: "/\u212a/private",
        }),
      ).resolves.toMatchObject({ sessionDirs: [path.resolve("/\u212a/private")] });
    },
  );

  it("reads settings with a UTF-8 byte order mark like Pi", async () => {
    const root = await createTempDir("pi-runtime-storage-bom-");
    const agentDir = path.join(root, "agent");
    const settings = path.join(root, "settings.json");
    const history = path.join(root, "history");
    await writeFile(settings, `\uFEFF${JSON.stringify({ sessionDir: history })}`);
    await expect(piRuntimeStorage(agentDir, settings, {})).resolves.toEqual({
      agentDir,
      sessionDirs: [history],
    });
  });

  it.skipIf(process.platform === "win32")("refuses a non-local file URL", async () => {
    const root = await createTempDir("pi-runtime-storage-invalid-url-");
    await expect(
      piRuntimeStorage(path.join(root, "agent"), path.join(root, "missing.json"), {
        PI_CODING_AGENT_SESSION_DIR: "file://remote-host/sessions",
      }),
    ).rejects.toThrow("[PI_SESSION_DIR_INVALID]");
  });

  it("reports why settings could not be read", async () => {
    const root = await createTempDir("pi-runtime-storage-unreadable-");
    await expect(piRuntimeStorage(path.join(root, "agent"), root, {})).rejects.toThrow(
      /\[PI_RUNTIME_STORAGE_UNREADABLE\].*\(EISDIR\)/u,
    );
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
