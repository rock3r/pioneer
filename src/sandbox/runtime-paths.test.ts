import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executableRuntimeRoot } from "./runtime-paths.js";

describe("executableRuntimeRoot", () => {
  it("grants the canonical Node installation prefix on Linux", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pioneer-runtime-"));
    const runtime = path.join(root, "opt", "hostedtoolcache", "node", "22", "x64", "bin");
    const executable = path.join(runtime, "node");
    const linkedExecutable = path.join(root, "node");
    await mkdir(runtime, { recursive: true });
    await writeFile(executable, "");
    await symlink(executable, linkedExecutable);

    expect(await executableRuntimeRoot(linkedExecutable, "linux")).toBe(await realpath(executable));
  });

  it("grants the package prefix for a macOS executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pioneer-runtime-"));
    const runtime = path.join(root, "opt", "node", "bin");
    const executable = path.join(runtime, "node");
    await mkdir(runtime, { recursive: true });
    await writeFile(executable, "");

    expect(await executableRuntimeRoot(executable, "darwin")).toBe(
      path.resolve(path.dirname(await realpath(executable)), ".."),
    );
  });
});
