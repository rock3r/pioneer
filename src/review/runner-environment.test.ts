import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { piRuntimePaths, reviewProcessEnvironment } from "./runner.js";

const { createTempDir } = registerManagedTempPaths();

describe("review actor environment", () => {
  it("keeps runtime and isolated Pi variables without inheriting host secrets or outer-agent state", () => {
    const environment = reviewProcessEnvironment(
      {},
      { PI_CODING_AGENT_DIR: "/isolated/pi-home", PI_OFFLINE: "1" },
      {
        PATH: "/runtime/bin",
        PATHEXT: ".COM;.EXE;.CMD",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        LANG: "en_US.UTF-8",
        PIONEER_HOST_SECRET: "must-not-leak",
        OUTER_AGENT_PROJECT_ROOT: "/outer/project",
        OPENROUTER_API_KEY: "must-not-leak",
      },
    );

    expect(environment.PATH).toBe("/runtime/bin");
    expect(environment.PATHEXT).toBe(".COM;.EXE;.CMD");
    expect(environment.SystemRoot).toBe("C:\\Windows");
    expect(environment.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(environment.LANG).toBe("en_US.UTF-8");
    expect(environment.PI_CODING_AGENT_DIR).toBe("/isolated/pi-home");
    expect(environment.PIONEER_HOST_SECRET).toBeUndefined();
    expect(environment.OUTER_AGENT_PROJECT_ROOT).toBeUndefined();
    expect(environment.OPENROUTER_API_KEY).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "grants the executable Pi package instead of an earlier non-executable PATH entry",
    async () => {
      const root = await createTempDir("pioneer-pi-runtime-grant-");
      const earlier = path.join(root, "earlier");
      const bin = path.join(root, "bin");
      const packageRoot = path.join(root, "pkg");
      const target = path.join(packageRoot, "dist", "cli.js");
      await mkdir(earlier);
      await mkdir(bin);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(path.join(earlier, "pi"), "not executable\n");
      await chmod(path.join(earlier, "pi"), 0o644);
      await writeFile(target, "#!/usr/bin/env node\n", { mode: 0o755 });
      await writeFile(path.join(packageRoot, "package.json"), "{}\n");
      await symlink(target, path.join(bin, "pi"));
      const previous = process.env.PATH;
      process.env.PATH = `${earlier}${path.delimiter}${bin}`;
      try {
        const grants = await piRuntimePaths("pi");
        expect(grants).toContain(await realpath(packageRoot));
        expect(grants).not.toContain(path.join(earlier, "pi"));
      } finally {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
      }
    },
  );
});
