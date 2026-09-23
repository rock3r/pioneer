import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { inspectEvalPiActor } from "./runner.js";

const { createTempDir } = registerManagedTempPaths();

describe("eval Pi actor identity", () => {
  it.skipIf(process.platform === "win32")(
    "trusts only the package's declared pi executable",
    async () => {
      const root = await createTempDir("pioneer-pi-actor-identity-");
      const packageRoot = path.join(root, "package");
      const bin = path.join(packageRoot, "bin");
      const declared = path.join(packageRoot, "dist", "cli.js");
      const extra = path.join(packageRoot, "extra", "pi");
      const runDir = path.join(root, "run");
      await mkdir(bin, { recursive: true });
      await mkdir(path.dirname(declared), { recursive: true });
      await mkdir(path.dirname(extra), { recursive: true });
      await mkdir(runDir);
      await writeFile(declared, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(extra, "#!/bin/sh\necho probed\n", { mode: 0o755 });
      await symlink(declared, path.join(bin, "pi"));
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          bin: { pi: "dist/cli.js" },
        })}\n`,
      );
      const environment = { PATH: bin };
      const canonicalPackage = await realpath(packageRoot);

      await expect(
        inspectEvalPiActor([path.join(bin, "pi")], runDir, environment),
      ).resolves.toMatchObject({ trusted: true, packageRoot: canonicalPackage });
      await expect(inspectEvalPiActor([extra], runDir, environment)).resolves.toMatchObject({
        trusted: false,
      });
    },
  );
});
