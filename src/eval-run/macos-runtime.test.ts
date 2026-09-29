import { describe, expect, it } from "vitest";
import { macosSystemToolReadPaths } from "./macos-runtime.js";

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

  it("adds nothing on other platforms", async () => {
    await expect(
      macosSystemToolReadPaths("linux", resolver({ "/private/var/select": "/private/var/select" })),
    ).resolves.toEqual([]);
  });
});
