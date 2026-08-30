import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { resolveNpmPiCmdShim, resolvePiCommand } from "./pi-command.js";

const { createTempDir } = registerManagedTempPaths();

async function npmPiFixture(root: string): Promise<{
  readonly shim: string;
  readonly target: string;
}> {
  const bin = path.join(root, "bin");
  const packageRoot = path.join(bin, "node_modules", "@earendil-works", "pi-coding-agent");
  const target = path.join(packageRoot, "dist", "cli.js");
  const shim = path.join(bin, "pi.cmd");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }),
  );
  await writeFile(target, "process.stdout.write('fixture');\n");
  await writeFile(
    shim,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
      "",
    ].join("\r\n"),
  );
  return { shim, target };
}

describe("Windows Pi command resolution", () => {
  it("unwraps a generated npm pi.cmd shim into an argv-safe Node launch", async () => {
    const fixture = await npmPiFixture(await createTempDir("pioneer-pi-cmd-"));

    await expect(resolveNpmPiCmdShim(fixture.shim, process.execPath)).resolves.toEqual([
      process.execPath,
      await realpath(fixture.target),
    ]);
  });

  it("prefers the npm cmd shim over its extensionless POSIX sibling", async () => {
    const fixture = await npmPiFixture(await createTempDir("pioneer-pi-cmd-siblings-"));
    const bin = path.dirname(fixture.shim);
    await writeFile(path.join(bin, "pi"), "#!/bin/sh\n");

    await expect(
      resolvePiCommand("pi", { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32"),
    ).resolves.toEqual([process.execPath, await realpath(fixture.target)]);
  });

  it("rejects a cmd file that is not an npm-generated Pi shim", async () => {
    const root = await createTempDir("pioneer-pi-cmd-invalid-");
    const shim = path.join(root, "pi.cmd");
    await writeFile(shim, "@echo off\r\nnode attacker.js %*\r\n");

    await expect(resolveNpmPiCmdShim(shim, process.execPath)).rejects.toThrow(
      "not a recognized npm Pi shim",
    );
  });

  it("rejects a generated shim whose package manifest does not own the target", async () => {
    const fixture = await npmPiFixture(await createTempDir("pioneer-pi-cmd-mismatch-"));
    const packageRoot = path.dirname(path.dirname(fixture.target));
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/other.js" } }),
    );

    await expect(resolveNpmPiCmdShim(fixture.shim, process.execPath)).rejects.toThrow(
      "does not match the installed Pi package entry point",
    );
  });
});
