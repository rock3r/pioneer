import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
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

  it("resolves the review's project session directory against the source root", async () => {
    const root = await realpath(await createTempDir("pi-project-settings-"));
    const agent = path.join(root, "agent");
    const globalSettings = path.join(root, "global.json");
    const source = path.join(root, "repository");
    const projectSettings = path.join(source, ".pi", "settings.json");
    await mkdir(path.dirname(projectSettings), { recursive: true });
    await writeFile(globalSettings, JSON.stringify({ sessionDir: "~/global-history" }));
    await writeFile(projectSettings, JSON.stringify({ sessionDir: "history" }));
    const env = { HOME: root, USERPROFILE: root };

    await expect(piRuntimeStorage(agent, globalSettings, env, source)).resolves.toEqual({
      agentDir: agent,
      sessionDirs: [path.join(root, "global-history")],
      repositorySessionDirs: [path.join(source, "history")],
    });
    await expect(piRuntimeStorage(agent, globalSettings, env)).resolves.toEqual({
      agentDir: agent,
      sessionDirs: [path.join(root, "global-history")],
    });

    for (const [value, expected] of [
      ["~/tilde-history", path.join(root, "tilde-history")],
      [pathToFileURL(path.join(root, "url-history")).href, path.join(root, "url-history")],
    ] as const) {
      await writeFile(projectSettings, `\uFEFF${JSON.stringify({ sessionDir: value })}`);
      await expect(piRuntimeStorage(agent, globalSettings, env, source)).resolves.toMatchObject({
        repositorySessionDirs: [expected],
      });
    }
    await writeFile(globalSettings, JSON.stringify({ sessionDir: "relative" }));
    await expect(piRuntimeStorage(agent, globalSettings, env, source)).rejects.toThrow(
      "[PI_SESSION_DIR_RELATIVE]",
    );
  });

  it("ignores unusable project settings and accepts a file at exactly 64 KiB", async () => {
    const source = await realpath(await createTempDir("pi-project-settings-limit-"));
    const agent = path.join(source, "agent");
    const globalSettings = path.join(source, "global.json");
    const settings = path.join(source, ".pi", "settings.json");
    await mkdir(path.dirname(settings));
    const storage = () => piRuntimeStorage(agent, globalSettings, {}, source);
    const ignored = { repositorySessionDirs: [] };
    await expect(storage()).resolves.toMatchObject(ignored);

    const valid = JSON.stringify({ sessionDir: "history" });
    for (const contents of [
      "{",
      "{}",
      '{"sessionDir":42}',
      '{"sessionDir":""}',
      '{"sessionDir":"bad\\u0000path"}',
      '{"sessionDir":"file:///%ZZ"}',
      valid.padEnd(64 * 1024 + 1, " "),
    ]) {
      await writeFile(settings, contents);
      await expect(storage()).resolves.toMatchObject(ignored);
    }
    await writeFile(settings, valid.padEnd(64 * 1024, " "));
    await expect(storage()).resolves.toMatchObject({
      repositorySessionDirs: [path.join(source, "history")],
    });
    const nonRegular = await realpath(await createTempDir("pi-project-settings-directory-"));
    await mkdir(path.join(nonRegular, ".pi", "settings.json"), { recursive: true });
    await expect(piRuntimeStorage(agent, globalSettings, {}, nonRegular)).resolves.toMatchObject(
      ignored,
    );
  });

  it.skipIf(process.platform === "win32")(
    "accepts contained settings links and ignores links outside the repository",
    async () => {
      const root = await realpath(await createTempDir("pi-project-settings-links-"));
      const source = path.join(root, "source");
      const adjacent = path.join(root, "source-adjacent");
      await mkdir(path.join(source, ".pi"), { recursive: true });
      await mkdir(adjacent);
      await writeFile(path.join(source, "settings.json"), '{"sessionDir":"history"}');
      await writeFile(path.join(adjacent, "settings.json"), '{"sessionDir":"unrelated"}');
      await symlink("../settings.json", path.join(source, ".pi", "settings.json"));
      await symlink(adjacent, path.join(source, "history"));
      const agent = path.join(root, "agent");
      const globalSettings = path.join(root, "global.json");
      await expect(piRuntimeStorage(agent, globalSettings, {}, source)).resolves.toMatchObject({
        repositorySessionDirs: [path.join(source, "history"), adjacent],
      });
      const elsewhere = path.join(root, "elsewhere");
      await mkdir(elsewhere);
      await symlink(adjacent, path.join(elsewhere, ".pi"));
      await expect(piRuntimeStorage(agent, globalSettings, {}, elsewhere)).resolves.toMatchObject({
        repositorySessionDirs: [],
      });
      const linkedFile = path.join(root, "linked-file");
      await mkdir(path.join(linkedFile, ".pi"), { recursive: true });
      await symlink(
        path.join(adjacent, "settings.json"),
        path.join(linkedFile, ".pi", "settings.json"),
      );
      await expect(piRuntimeStorage(agent, globalSettings, {}, linkedFile)).resolves.toMatchObject({
        repositorySessionDirs: [],
      });
    },
  );

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
