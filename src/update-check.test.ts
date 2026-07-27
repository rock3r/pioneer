import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkForUpdate,
  fetchLatestVersionFromNpm,
  isNewerVersion,
  npmCliCommand,
  systemNpmCliPaths,
  trustedNpmEnvironment,
  type UpdateCheckState,
  type UpdateStateStore,
  withIsolatedNpmConfig,
} from "./update-check.js";

function store(
  initial: UpdateCheckState | undefined,
): UpdateStateStore & { writes: UpdateCheckState[] } {
  let value = initial;
  const writes: UpdateCheckState[] = [];
  return {
    writes,
    async read() {
      return value;
    },
    async write(next) {
      value = next;
      writes.push(next);
    },
  };
}

describe("package update checks", () => {
  it("uses a successful cached result for 24 hours without contacting npm", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });
    const lookup = async () => {
      throw new Error("npm should not be contacted");
    };

    await expect(
      checkForUpdate({ currentVersion: "0.1.4", now: 1_000 + 86_399_999, store: cache, lookup }),
    ).resolves.toEqual({ checked: false, latestVersion: "0.2.0", updateAvailable: true });
  });

  it("refreshes the npm version after the 24-hour cooldown and persists it", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });

    await expect(
      checkForUpdate({
        currentVersion: "0.1.4",
        now: 1_000 + 86_400_000,
        store: cache,
        lookup: async () => "0.3.0",
      }),
    ).resolves.toEqual({ checked: true, latestVersion: "0.3.0", updateAvailable: true });
    expect(cache.writes).toEqual([
      { schemaVersion: 1, checkedAt: 86_401_000, latestVersion: "0.3.0" },
    ]);
  });

  it("forces a fresh npm query for a manual check", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });
    let calls = 0;

    const result = await checkForUpdate({
      currentVersion: "0.1.4",
      now: 1_001,
      force: true,
      store: cache,
      lookup: async () => {
        calls += 1;
        return "0.4.0";
      },
    });

    expect(calls).toBe(1);
    expect(result.latestVersion).toBe("0.4.0");
  });

  it("records a failed check time so normal startup does not retry on every invocation", async () => {
    const cache = store({ schemaVersion: 1, checkedAt: 1_000, latestVersion: "0.2.0" });

    await expect(
      checkForUpdate({
        currentVersion: "0.1.4",
        now: 86_401_000,
        store: cache,
        lookup: async () => {
          throw new Error("registry unavailable");
        },
      }),
    ).rejects.toThrow("registry unavailable");
    expect(cache.writes).toEqual([
      { schemaVersion: 1, checkedAt: 86_401_000, latestVersion: "0.2.0" },
    ]);
  });

  it("uses fixed npm argv and rejects malformed registry output", async () => {
    const invocations: Array<readonly [string, readonly string[]]> = [];
    await expect(
      fetchLatestVersionFromNpm(async (command, args) => {
        invocations.push([command, args]);
        return '"0.2.0"\n';
      }),
    ).resolves.toBe("0.2.0");
    expect(invocations).toEqual([
      [
        "npm",
        expect.arrayContaining([
          "view",
          "@rock3r/pioneer",
          "version",
          "--json",
          "--registry=https://registry.npmjs.org/",
          "--fetch-retries=0",
          "--fetch-timeout=5000",
        ]),
      ],
    ]);
    await expect(fetchLatestVersionFromNpm(async () => '"not-a-version"')).rejects.toThrow(
      "valid semantic version",
    );
  });

  it("uses ASCII ordering for prerelease identifiers", () => {
    expect(isNewerVersion("1.0.0-a", "1.0.0-B")).toBe(true);
    expect(isNewerVersion("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(true);
  });

  it("uses the Node distribution's npm CLI with a constrained cross-platform environment", () => {
    expect(npmCliCommand(["--version"], "/trusted/node", "win32")).toEqual([
      "/trusted/node",
      "\\trusted\\node_modules\\npm\\bin\\npm-cli.js",
      "--version",
    ]);
    expect(
      trustedNpmEnvironment(
        { PATH: "/trusted/bin", PATHEXT: ".EXE", APPDATA: "app", NPM_TOKEN: "secret" },
        "/trusted/home",
        "/trusted/node",
        "linux",
      ),
    ).toEqual({
      PATH: "/trusted:/usr/bin:/bin",
      HOME: "/trusted/home",
      PATHEXT: ".EXE",
      APPDATA: "app",
    });
    expect(systemNpmCliPaths("darwin")).toEqual([
      "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/lib/node_modules/npm/bin/npm-cli.js",
    ]);
  });

  it("runs npm from its private configuration directory", async () => {
    let workingDirectory = "";

    await withIsolatedNpmConfig(async (configArguments, cwd) => {
      workingDirectory = cwd;
      const [userConfigArgument, globalConfigArgument] = configArguments;
      const userConfig = userConfigArgument.slice("--userconfig=".length);
      const globalConfig = globalConfigArgument.slice("--globalconfig=".length);

      expect(path.dirname(userConfig)).toBe(cwd);
      expect(path.dirname(globalConfig)).toBe(cwd);
      await expect(readFile(userConfig, "utf8")).resolves.toBe("");
      await expect(readFile(globalConfig, "utf8")).resolves.toBe("");
      await expect(access(path.join(cwd, ".npmrc"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    await expect(access(workingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
