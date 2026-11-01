import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  macosFallbackDeveloperReadPaths,
  macosPrivateToolEnvironment,
  macosSystemToolReadPaths,
  selectedMacosDeveloperDir,
} from "./macos-runtime.js";

function resolver(links: Readonly<Record<string, string>>): (candidate: string) => Promise<string> {
  return async (candidate) => {
    const target = links[candidate];
    if (target === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return target;
  };
}

describe("macOS system tool read paths (#87)", () => {
  it("grants the shell selector and the Command Line Tools developer directory", async () => {
    await expect(
      macosSystemToolReadPaths(
        "darwin",
        resolver({
          "/private/var/select": "/private/var/select",
          "/private/var/select/developer_dir": "/Library/Developer/CommandLineTools",
        }),
      ),
    ).resolves.toEqual(["/private/var/select", "/Library/Developer/CommandLineTools"]);
  });

  it("grants the whole Xcode bundle, whose tools load its Info.plist and SharedFrameworks", async () => {
    await expect(
      macosSystemToolReadPaths(
        "darwin",
        resolver({
          "/private/var/select": "/private/var/select",
          "/private/var/select/developer_dir": "/Applications/Xcode-beta.app/Contents/Developer",
          "/Library/Preferences/com.apple.dt.Xcode.plist":
            "/Library/Preferences/com.apple.dt.Xcode.plist",
        }),
      ),
    ).resolves.toEqual([
      "/private/var/select",
      "/Applications/Xcode-beta.app",
      // xcrun reads the Xcode license acceptance here and exits 69 when it cannot.
      "/Library/Preferences/com.apple.dt.Xcode.plist",
    ]);
  });

  it.each([
    "/",
    "/Library",
    "/Library/Developer",
    "/Users/someone/Developer",
    "/Applications",
    "/Applications/Xcode.app",
    "/private/var/select/../../etc",
  ])("does not widen the grant to an unexpected developer directory: %s", async (target) => {
    await expect(
      macosSystemToolReadPaths(
        "darwin",
        resolver({
          "/private/var/select": "/private/var/select",
          "/private/var/select/developer_dir": target,
        }),
      ),
    ).resolves.toEqual(["/private/var/select"]);
  });

  it("omits the Xcode preferences file when it is absent", async () => {
    await expect(
      macosSystemToolReadPaths(
        "darwin",
        resolver({
          "/private/var/select": "/private/var/select",
          "/private/var/select/developer_dir": "/Applications/Xcode.app/Contents/Developer",
        }),
      ),
    ).resolves.toEqual(["/private/var/select", "/Applications/Xcode.app"]);
  });

  it("omits paths that are absent on the host", async () => {
    await expect(macosSystemToolReadPaths("darwin", resolver({}))).resolves.toEqual([]);
  });

  it("uses the printed developer directory only when the selector symlink is absent", async () => {
    const identity = async (candidate: string): Promise<string> => candidate;
    await expect(
      selectedMacosDeveloperDir(
        "darwin",
        async () => "/Applications/Xcode.app/Contents/Developer\n",
        identity,
      ),
    ).resolves.toBe("/Applications/Xcode.app/Contents/Developer");
    await expect(
      selectedMacosDeveloperDir(
        "darwin",
        async () => "/Library/Developer/CommandLineTools",
        identity,
      ),
    ).resolves.toBe("/Library/Developer/CommandLineTools");
    await expect(
      selectedMacosDeveloperDir("darwin", async () => "/Users/someone/Developer", identity),
    ).resolves.toBeUndefined();
    await expect(
      selectedMacosDeveloperDir("linux", async () => "/Applications/Xcode.app"),
    ).resolves.toBeUndefined();
    await expect(
      macosFallbackDeveloperReadPaths("/Applications/Xcode.app/Contents/Developer", async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).resolves.toEqual(["/Applications/Xcode.app"]);
    await expect(macosFallbackDeveloperReadPaths("/")).resolves.toEqual([]);
    expect(macosPrivateToolEnvironment("/private/tmp/pioneer-eval-control/actor-scratch")).toEqual({
      xcrun_db: path.join("/private/tmp/pioneer-eval-control/actor-scratch", "xcrun_db"),
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });

  it("adds nothing on other platforms", async () => {
    await expect(
      macosSystemToolReadPaths("linux", resolver({ "/private/var/select": "/private/var/select" })),
    ).resolves.toEqual([]);
  });
});
