import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createManagedPiInstall } from "../test/support/pi-managed-install.js";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  EXTENSION_ADAPTER_FILES,
  installedPiRoot,
  withNoForkSandbox,
} from "./pi-extension-runtime.js";

const { createTempDir } = registerManagedTempPaths();

it("marks only macOS adapter commands as running without process creation", () => {
  const command = ["/node", "/staged/entry.mjs", "/pi"] as const;
  expect(withNoForkSandbox(command, "darwin")).toEqual([...command, "--pioneer-no-fork-sandbox"]);
  expect(withNoForkSandbox(command, "linux")).toEqual(command);
  expect(withNoForkSandbox(command, "win32")).toEqual(command);
});

it("stages every module that the sandboxed extension adapter imports", async () => {
  const staged = new Set(EXTENSION_ADAPTER_FILES.map(([source]) => source));
  const missing: string[] = [];
  for (const source of staged) {
    const text = await readFile(
      path.join(import.meta.dirname, source.replace(/\.js$/, ".ts")),
      "utf8",
    );
    for (const match of text.matchAll(/(?:from|import\()\s*"\.\/([^"]+\.js)"/g)) {
      const imported = match[1];
      if (imported !== undefined && !staged.has(imported)) missing.push(`${source} -> ${imported}`);
    }
  }
  expect(missing).toEqual([]);
});

it("does not silently select a different Pi farther down PATH", async () => {
  const root = await createTempDir("pi-root-binding-");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await mkdir(first);
  await mkdir(second);
  for (const directory of [first, second]) {
    await writeFile(path.join(directory, "pi"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(directory, "pi"), 0o700);
  }
  await writeFile(path.join(second, "package.json"), '{"name":"@earendil-works/pi-coding-agent"}');
  await expect(
    installedPiRoot(["pi"], { PATH: [first, second].join(path.delimiter) }),
  ).rejects.toThrow("[PI_EXTENSION_RUNTIME_UNSUPPORTED]");
  await expect(installedPiRoot(["pi"], { PATH: second })).resolves.toBe(await realpath(second));
});

// Pi's managed installer writes a POSIX shell launcher at ~/.pi/agent/bin/pi (#126).
it.skipIf(process.platform === "win32")(
  "finds the official package behind Pi's managed installer launcher",
  async () => {
    const home = await createTempDir("pi-root-managed-");
    const install = await createManagedPiInstall(path.join(home, ".pi", "agent"));
    const userBin = path.join(home, "bin");
    await mkdir(userBin);
    await symlink(path.join(install.binDir, "pi"), path.join(userBin, "pi"));
    const packageRoot = await realpath(install.packageRoot);

    await expect(installedPiRoot(["pi"], { PATH: userBin })).resolves.toBe(packageRoot);
    await expect(installedPiRoot(["pi"], { PATH: install.binDir })).resolves.toBe(packageRoot);
    await expect(installedPiRoot([path.join(install.binDir, "pi")], {})).resolves.toBe(packageRoot);
  },
);
