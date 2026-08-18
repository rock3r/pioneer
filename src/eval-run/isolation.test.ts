import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPiHomeSeparatedFromActorGrants,
  buildEvalExecutableReadPaths,
  buildEvalSandboxConfig,
  evalIsolatedPiHomeWritablePaths,
  findValidatedPiPackageRoot,
  isPublicInternetAddress,
  isTrustedPiInstallation,
  MAX_SHEBANG_RESOLUTION_DEPTH,
  resolveEvalExecutable,
  validateEvalRunSpec,
  validateEvalWorkLogPath,
} from "./isolation.js";

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

describe("validateEvalRunSpec", () => {
  it("resolves a bare executable through the selected PATH to a canonical file", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const executable = path.join(binDir, "actor");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const expected = await realpath(executable);
    await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toEqual({
      commandPath: expected,
      readPaths: uniquePaths([path.join(binDir, "actor"), expected]),
    });
  });

  it("resolves an absolute symlink to its executable target and grants both identities", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    await mkdir(runDir);
    const target = path.join(temp, "actor.js");
    const launcher = path.join(temp, "actor");
    await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await import("node:fs/promises").then(({ symlink }) => symlink(target, launcher));

    await expect(resolveEvalExecutable(launcher, runDir, "")).resolves.toEqual({
      commandPath: await realpath(target),
      readPaths: [launcher, await realpath(target)],
    });
  });

  it("resolves a relative path against the validated actor run directory", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    await mkdir(path.join(runDir, "bin"), { recursive: true });
    const executable = path.join(runDir, "bin", "actor");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const expected = await realpath(executable);
    await expect(resolveEvalExecutable("bin/actor", runDir, "")).resolves.toEqual({
      commandPath: expected,
      readPaths: uniquePaths([path.join(runDir, "bin/actor"), expected]),
    });
  });

  it("resolves a relative env interpreter from the actor run directory", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-relative-interpreter-"));
    const runDir = path.join(temp, "run");
    const interpreter = path.join(runDir, "interpreter");
    const actor = path.join(temp, "actor");
    await mkdir(runDir);
    await writeFile(interpreter, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(actor, "#!/usr/bin/env ./interpreter\n", { mode: 0o755 });

    const interpreterCanonical = await realpath(interpreter);
    const actorCanonical = await realpath(actor);
    await expect(resolveEvalExecutable(actor, runDir, "")).resolves.toEqual({
      commandPath: actorCanonical,
      command: [interpreter, actor],
      readPaths: uniquePaths([actor, actorCanonical, interpreter, interpreterCanonical]),
    });
  });

  it.skipIf(process.platform !== "win32")(
    "expands a bare PATH executable through PATHEXT on Windows",
    async () => {
      const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-windows-path-"));
      const runDir = path.join(temp, "run");
      const binDir = path.join(temp, "bin");
      await mkdir(runDir);
      await mkdir(binDir);
      const executable = path.join(binDir, "actor.cmd");
      await writeFile(executable, "@echo off\r\n", { mode: 0o755 });

      await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toMatchObject({
        commandPath: await realpath(executable),
      });
    },
  );

  it("rewrites env shebang scripts to an explicit canonical interpreter", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const interpreter = path.join(binDir, "node");
    const script = path.join(binDir, "actor");
    await writeFile(interpreter, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(script, "#!/usr/bin/env node\n", { mode: 0o755 });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toMatchObject({
      command: [interpreter, script],
      readPaths: expect.arrayContaining([await realpath(interpreter), await realpath(script)]),
    });
  });

  it("does not tokenize a non-`-S` env command name", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-env-plain-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    await writeFile(path.join(binDir, "node"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(binDir, "actor"), '#!/usr/bin/env "node"\n', { mode: 0o755 });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).rejects.toThrow(/not found/);
  });

  it("preserves the lexical script path for a symlinked env shebang actor", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-lexical-shebang-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const interpreter = path.join(binDir, "node");
    const target = path.join(temp, "actor-target");
    const launcher = path.join(binDir, "actor");
    await writeFile(interpreter, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(target, `#!/usr/bin/env ${interpreter.replaceAll(path.sep, "/")}\n`, {
      mode: 0o755,
    });
    await import("node:fs/promises").then(({ symlink }) => symlink(target, launcher));

    await expect(resolveEvalExecutable(launcher, runDir, "")).resolves.toEqual({
      commandPath: await realpath(target),
      command: [interpreter, launcher],
      readPaths: uniquePaths([
        launcher,
        await realpath(target),
        interpreter,
        await realpath(interpreter),
      ]),
    });
  });

  it("preserves arguments from an env -S shebang in exec order", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-env-shebang-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const interpreter = path.join(binDir, "deno");
    const actor = path.join(binDir, "actor");
    await writeFile(interpreter, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      actor,
      "#!/usr/bin/env -S -- deno run --config 'my config.json' --mode=\"fast mode\"\n",
      { mode: 0o755 },
    );

    const interpreterCanonical = await realpath(interpreter);
    const actorCanonical = await realpath(actor);
    await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toEqual({
      commandPath: actorCanonical,
      command: [interpreter, "run", "--config", "my config.json", "--mode=fast mode", actor],
      readPaths: uniquePaths([
        path.join(binDir, "actor"),
        actorCanonical,
        path.join(binDir, "deno"),
        interpreterCanonical,
      ]),
    });
  });

  it("fails closed for unsupported env -S escape sequences", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-env-escape-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    await writeFile(path.join(binDir, "deno"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(binDir, "actor"), "#!/usr/bin/env -S deno --mode=fast\\_mode\n", {
      mode: 0o755,
    });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );

    await writeFile(path.join(binDir, "actor"), "#!/usr/bin/env -S deno arg\\ value\n", {
      mode: 0o755,
    });
    await expect(resolveEvalExecutable("actor", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );

    await writeFile(
      path.join(binDir, "actor"),
      `#!/usr/bin/env -S deno --config=${["$", "{HOME}"].join("")}/config.json\n`,
      { mode: 0o755 },
    );
    await expect(resolveEvalExecutable("actor", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );
  });

  it("preserves a complete nested env shebang command and every exact read grant", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-nested-shebang-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const finalTarget = path.join(temp, "final-target");
    const finalLauncher = path.join(binDir, "final");
    const middle = path.join(binDir, "middle");
    const actor = path.join(binDir, "actor");
    await writeFile(finalTarget, "#!/bin/sh\n", { mode: 0o755 });
    await import("node:fs/promises").then(({ symlink }) => symlink(finalTarget, finalLauncher));
    await writeFile(middle, "#!/usr/bin/env final\n", { mode: 0o755 });
    await writeFile(actor, "#!/usr/bin/env middle\n", { mode: 0o755 });

    const finalCanonical = await realpath(finalTarget);
    const middleCanonical = await realpath(middle);
    const actorCanonical = await realpath(actor);
    await expect(resolveEvalExecutable("actor", runDir, binDir)).resolves.toEqual({
      commandPath: actorCanonical,
      command: [finalLauncher, middle, actor],
      readPaths: uniquePaths([
        path.join(binDir, "actor"),
        actorCanonical,
        path.join(binDir, "middle"),
        middleCanonical,
        finalLauncher,
        finalCanonical,
      ]),
    });
  });

  it("fails closed when the first PATH executable has an unresolvable interpreter", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    const firstBin = path.join(temp, "first-bin");
    const secondBin = path.join(temp, "second-bin");
    await mkdir(runDir);
    await mkdir(firstBin);
    await mkdir(secondBin);
    await writeFile(path.join(firstBin, "actor"), "#!/usr/bin/env missing-interpreter\n", {
      mode: 0o755,
    });
    await writeFile(path.join(secondBin, "actor"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    await expect(
      resolveEvalExecutable("actor", runDir, [firstBin, secondBin].join(path.delimiter)),
    ).rejects.toThrow(/interpreter|not found/i);
  });

  it("fails closed with a stable diagnostic for a self-referential env shebang", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-shebang-cycle-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    await writeFile(path.join(binDir, "actor"), "#!/usr/bin/env actor\n", { mode: 0o755 });

    await expect(resolveEvalExecutable("actor", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );
  }, 1_000);

  it("fails closed with a stable diagnostic for a two-file env shebang cycle", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-shebang-cycle-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    await writeFile(path.join(binDir, "first"), "#!/usr/bin/env second\n", { mode: 0o755 });
    await writeFile(path.join(binDir, "second"), "#!/usr/bin/env first\n", { mode: 0o755 });

    await expect(resolveEvalExecutable("first", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );
  }, 1_000);

  it("fails closed when env shebang resolution exceeds its explicit depth bound", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-shebang-depth-"));
    const runDir = path.join(temp, "run");
    const binDir = path.join(temp, "bin");
    await mkdir(runDir);
    await mkdir(binDir);
    const chainLength = MAX_SHEBANG_RESOLUTION_DEPTH + 1;
    for (let index = 0; index < chainLength; index += 1) {
      await writeFile(path.join(binDir, `actor-${index}`), `#!/usr/bin/env actor-${index + 1}\n`, {
        mode: 0o755,
      });
    }
    await writeFile(path.join(binDir, `actor-${chainLength}`), "#!/bin/sh\n", {
      mode: 0o755,
    });

    await expect(resolveEvalExecutable("actor-0", runDir, binDir)).rejects.toThrow(
      "[EVAL_SHEBANG_RESOLUTION_FAILED]",
    );
  });

  it.each([
    ["missing", "missing"],
    ["directory", "."],
  ])("fails closed for a %s executable", async (_label, executable) => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    await mkdir(runDir);
    await expect(resolveEvalExecutable(executable, runDir, "")).rejects.toThrow(/executable/i);
  });

  it("fails closed for a non-executable and broken symlink", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    await mkdir(runDir);
    const nonExecutable = path.join(temp, "not-executable.txt");
    await writeFile(nonExecutable, "exit 0\n", { mode: 0o644 });
    const broken = path.join(temp, "broken");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(path.join(temp, "gone"), broken),
    );

    await expect(resolveEvalExecutable(nonExecutable, runDir, "")).rejects.toThrow(/executable/i);
    await expect(resolveEvalExecutable(broken, runDir, "")).rejects.toThrow(/executable/i);
  });

  it("does not parse an oversized Pi package manifest", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-package-"));
    const packageRoot = path.join(temp, "package");
    const binDir = path.join(packageRoot, "bin");
    await mkdir(binDir, { recursive: true });
    const executable = path.join(binDir, "pi");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", padding: "x".repeat(70 * 1024) }),
    );

    await expect(findValidatedPiPackageRoot(executable)).resolves.toBeUndefined();
  });

  it("rejects an actor-spoofed Pi package root that contains the run directory", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-package-"));
    const packageRoot = path.join(temp, "package");
    const runDir = path.join(packageRoot, "run");
    const executable = path.join(runDir, "pi");
    await mkdir(runDir, { recursive: true });
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );

    await expect(findValidatedPiPackageRoot(executable, runDir)).resolves.toBeUndefined();
  });

  it("rejects an actor-spoofed Pi package root inside the writable run directory", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-package-"));
    const runDir = path.join(temp, "run");
    const packageRoot = path.join(runDir, "package");
    const binDir = path.join(packageRoot, "bin");
    const executable = path.join(binDir, "pi");
    await mkdir(binDir, { recursive: true });
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );

    await expect(findValidatedPiPackageRoot(executable, runDir)).resolves.toBeUndefined();
  });

  it("accepts only a Pi package root matching the controller-trusted installation", () => {
    const trusted = { packageRoot: "/opt/pi" };
    expect(isTrustedPiInstallation(trusted, trusted)).toBe(true);
    expect(isTrustedPiInstallation({ packageRoot: "/workspace/pi" }, trusted)).toBe(false);
    expect(isTrustedPiInstallation(undefined, trusted)).toBe(false);
  });

  it("rejects NUL argv and relative paths that escape the run directory", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-executable-"));
    const runDir = path.join(temp, "run");
    await mkdir(runDir);

    await expect(resolveEvalExecutable("actor\0", runDir, "")).rejects.toThrow(/NUL/i);
    await expect(resolveEvalExecutable("../actor", runDir, "")).rejects.toThrow(/run directory/i);
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes the run directory and rejects broad runtime grants",
    async () => {
      const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-"));
      const runDir = path.join(temp, "run");
      await mkdir(runDir);
      await mkdir(path.join(runDir, "runtime"));

      await expect(
        validateEvalRunSpec({ runDir: "/tmp", command: ["/usr/bin/true"] }),
      ).rejects.toThrow(/broad eval run directory/i);

      await expect(
        validateEvalRunSpec({
          runDir,
          command: ["/usr/bin/true"],
          runtimeReadPaths: ["/"],
        }),
      ).rejects.toThrow(/broad runtime read path/i);

      for (const broadPath of ["/etc", "/run"]) {
        if (!(await import("node:fs")).existsSync(broadPath)) continue;
        await expect(
          validateEvalRunSpec({
            runDir,
            command: ["/usr/bin/true"],
            runtimeReadPaths: [broadPath],
          }),
        ).rejects.toThrow(/broad runtime read path/i);
      }

      await expect(
        validateEvalRunSpec({
          runDir,
          command: ["/usr/bin/true"],
          runtimeReadPaths: [temp],
        }),
      ).rejects.toThrow(/overlap.*run directory/i);

      await expect(
        validateEvalRunSpec({
          runDir,
          command: ["/usr/bin/true"],
          runtimeReadPaths: [path.join(runDir, "runtime")],
        }),
      ).rejects.toThrow(/overlap.*run directory/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlinks anywhere inside the actor-visible run directory",
    async () => {
      const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-"));
      const runDir = path.join(temp, "run");
      await mkdir(runDir);
      await writeFile(path.join(temp, "outside.txt"), "secret");
      await import("node:fs/promises").then(({ symlink }) =>
        symlink(path.join(temp, "outside.txt"), path.join(runDir, "escape")),
      );

      await expect(validateEvalRunSpec({ runDir, command: ["/usr/bin/true"] })).rejects.toThrow(
        /symbolic link/i,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a Pi home that overlaps the actor run or runtime reads",
    async () => {
      const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-pi-home-"));
      const runDir = path.join(temp, "run");
      const nestedPiHome = path.join(runDir, "pi-home");
      const separatePiHome = path.join(temp, "separate-pi-home");
      await mkdir(nestedPiHome, { recursive: true });
      await mkdir(separatePiHome);

      await expect(
        validateEvalRunSpec({
          runDir,
          command: ["/usr/bin/true"],
          piHomeSource: nestedPiHome,
        }),
      ).rejects.toThrow(/Pi home.*overlap/i);

      await expect(
        validateEvalRunSpec({
          runDir,
          command: ["/usr/bin/true"],
          runtimeReadPaths: [separatePiHome],
          piHomeSource: separatePiHome,
        }),
      ).rejects.toThrow(/Pi home.*overlap/i);
    },
  );

  it("rejects a Pi home nested inside a derived executable package grant", () => {
    const packageRoot = path.resolve("/packages/pi-coding-agent");
    const piHome = path.join(packageRoot, "private-agent-home");

    expect(() => assertPiHomeSeparatedFromActorGrants(piHome, [packageRoot])).toThrow(
      /Pi home.*overlap/i,
    );
  });
});

describe("cross-platform sandbox config", () => {
  it.each([
    ["darwin", "/"],
    ["darwin", "/private/etc"],
    ["darwin", "/usr"],
    ["darwin", "/private/tmp"],
    ["darwin", "/private/var"],
    ["linux", "/"],
    ["linux", "/etc"],
    ["linux", "/run"],
    ["linux", "/usr"],
    ["linux", "/tmp"],
    ["linux", "/var"],
  ] as const)("rejects broad writable eval run directories on %s", (platform, runDir) => {
    expect(() =>
      buildEvalSandboxConfig({
        platform,
        runDir,
        runtimeReadPaths: [],
        parentProxyUrl: "http://srt:token@127.0.0.1:43123",
      }),
    ).toThrow(/broad eval run directory/i);
  });

  it.each([
    ["darwin", "/usr/local/eval-run"],
    ["darwin", "/Applications/Pioneer Eval.app"],
    ["darwin", "/Volumes/Data"],
    ["darwin", "/private/var/folders/ab/hash/C/pioneer-eval"],
    ["darwin", "/private/var/db/pioneer-eval"],
    ["linux", "/usr/local/eval-run"],
    ["linux", "/etc/pioneer-eval"],
    ["linux", "/private/var/folders/fake/pioneer-eval"],
    ["linux", "/var/lib/pioneer-eval"],
  ] as const)(
    "rejects writable eval directories below protected roots on %s",
    (platform, runDir) => {
      expect(() =>
        buildEvalSandboxConfig({
          platform,
          runDir,
          runtimeReadPaths: [],
          parentProxyUrl: "http://srt:token@127.0.0.1:43123",
        }),
      ).toThrow(/broad eval run directory/i);
    },
  );

  it.each([
    ["darwin", "/private/tmp/pioneer-eval/run"],
    ["darwin", "/private/var/folders/ab/hash/T/pioneer-eval/run"],
    ["linux", "/tmp/pioneer-eval/run"],
    ["linux", "/var/tmp/pioneer-eval/run"],
  ] as const)(
    "allows writable eval directories below disposable temp roots on %s",
    (platform, runDir) => {
      expect(
        buildEvalSandboxConfig({
          platform,
          runDir,
          runtimeReadPaths: [],
          parentProxyUrl: "http://srt:token@127.0.0.1:43123",
        }).writablePaths,
      ).toEqual([runDir]);
    },
  );

  it.each(["darwin", "linux"] as const)(
    "rejects runtime-read grants that overlap the writable run directory on %s",
    (platform) => {
      const runDir = "/narrow/eval/run";
      expect(() =>
        buildEvalSandboxConfig({
          platform,
          runDir,
          runtimeReadPaths: ["/narrow/eval"],
          parentProxyUrl: "http://srt:token@127.0.0.1:43123",
        }),
      ).toThrow(/overlap.*run directory/i);

      expect(
        buildEvalSandboxConfig({
          platform,
          runDir,
          runtimeReadPaths: ["/narrow/eval/run/runtime"],
          parentProxyUrl: "http://srt:token@127.0.0.1:43123",
        }).readOnlyPaths,
      ).toEqual([]);
    },
  );

  it("grants the isolated Pi agent directory writable so credential lock files can be created", () => {
    const piHome = {
      agentDir: "/tmp/pioneer-control/actor-scratch/pi-home/agent",
      homeDir: "/tmp/pioneer-control/actor-scratch/pi-home/home",
      tmpDir: "/tmp/pioneer-control/actor-scratch/pi-home/tmp",
    };
    const writableScratchPaths = evalIsolatedPiHomeWritablePaths(piHome);
    const config = buildEvalSandboxConfig({
      platform: "darwin",
      runDir: "/tmp/pioneer-eval/run",
      runtimeReadPaths: ["/opt/homebrew/bin/pi"],
      writableScratchPaths,
      parentProxyUrl: "http://srt:token@127.0.0.1:43123",
    });

    expect(writableScratchPaths).toEqual([piHome.homeDir, piHome.tmpDir, piHome.agentDir]);
    expect(config.writablePaths).toEqual([
      "/tmp/pioneer-eval/run",
      piHome.homeDir,
      piHome.tmpDir,
      piHome.agentDir,
    ]);
    expect(config.readOnlyPaths).not.toContain(piHome.agentDir);
  });

  it.each(["darwin", "linux"] as const)(
    "adds only a separate narrow controller-created actor scratch on %s",
    (platform) => {
      const runDir = "/tmp/pioneer-eval/run";
      const scratchDir = "/tmp/pioneer-control/actor-scratch";
      expect(
        buildEvalSandboxConfig({
          platform,
          runDir,
          runtimeReadPaths: [],
          writableScratchPaths: [scratchDir],
          parentProxyUrl: "http://srt:token@127.0.0.1:43123",
        }).writablePaths,
      ).toEqual([runDir, scratchDir]);

      expect(() =>
        buildEvalSandboxConfig({
          platform,
          runDir,
          runtimeReadPaths: [],
          writableScratchPaths: ["/tmp/pioneer-eval"],
          parentProxyUrl: "http://srt:token@127.0.0.1:43123",
        }),
      ).toThrow(/scratch.*overlap/i);
    },
  );

  it.each([
    ["darwin", "/", "/private/tmp/eval-run", ["/opt/tool/runtime", "/usr/bin/tool"]],
    ["linux", "/", "/tmp/eval-run", ["/opt/tool/runtime", "/usr/bin/tool"]],
  ] as const)(
    "denies the platform root and re-allows only the run and runtime on %s",
    (platform, deniedRoot, runDir, runtimeReadPaths) => {
      const config = buildEvalSandboxConfig({
        platform,
        runDir,
        runtimeReadPaths,
        parentProxyUrl: "http://srt:token@127.0.0.1:43123",
      });
      expect(deniedRoot).toBe("/");
      expect(config.readOnlyPaths).toEqual(runtimeReadPaths);
      expect(config.writablePaths).toEqual([runDir]);
      expect(config.network).toBe("proxy");
      expect(config.proxyUrl).toBe("http://srt:token@127.0.0.1:43123");
    },
  );

  it("refuses to construct the unsafe Windows drive-root ACL policy", () => {
    expect(() =>
      buildEvalSandboxConfig({
        platform: "win32",
        runDir: "C:\\evals\\run-1",
        runtimeReadPaths: ["C:\\Windows"],
        parentProxyUrl: "http://srt:token.0.0.1:43123",
      }),
    ).toThrow(/unavailable on Windows/i);
  });

  it("keeps executable grants narrow when the lexical path differs from its target", () => {
    const config = buildEvalSandboxConfig({
      platform: "darwin",
      runDir: "/private/tmp/eval-run",
      runtimeReadPaths: ["/opt/homebrew/bin/pi", "/opt/homebrew/lib/node_modules/pi/dist/cli.js"],
      parentProxyUrl: "http://srt:token@127.0.0.1:43123",
    });
    expect(config.readOnlyPaths).toEqual([
      "/opt/homebrew/bin/pi",
      "/opt/homebrew/lib/node_modules/pi/dist/cli.js",
    ]);
    expect(config.readOnlyPaths).not.toContain("/opt/homebrew");
  });

  it("permits an exact executable script directory without granting its broad parent", () => {
    const config = buildEvalSandboxConfig({
      platform: "darwin",
      runDir: "/private/tmp/eval-run",
      runtimeReadPaths: ["/opt/homebrew/lib/node_modules/pi/dist"],
      parentProxyUrl: "http://srt:token@127.0.0.1:43123",
    });
    expect(config.readOnlyPaths).toEqual(["/opt/homebrew/lib/node_modules/pi/dist"]);
    expect(config.readOnlyPaths).not.toContain("/opt/homebrew");
  });

  it("keeps a package dependency grant scoped to the resolved actor package", () => {
    const config = buildEvalSandboxConfig({
      platform: "darwin",
      runDir: "/private/tmp/eval-run",
      runtimeReadPaths: ["/opt/homebrew/lib/node_modules/pi-coding-agent"],
      parentProxyUrl: "http://srt:token@127.0.0.1:43123",
    });
    expect(config.readOnlyPaths).toEqual(["/opt/homebrew/lib/node_modules/pi-coding-agent"]);
    expect(config.readOnlyPaths).not.toContain("/opt/homebrew/lib/node_modules");
  });

  it("does not grant arbitrary actors their sibling directory or package root", () => {
    const actor = {
      commandPath: "/private/tmp/unrelated-package/bin/actor",
      readPaths: ["/private/tmp/unrelated-package/bin/actor"],
    } as const;
    const runtimeReadPaths = buildEvalExecutableReadPaths(actor);
    const config = buildEvalSandboxConfig({
      platform: "darwin",
      runDir: "/private/tmp/eval-run",
      runtimeReadPaths,
      parentProxyUrl: "http://srt:token@127.0.0.1:43123",
    });

    expect(config.readOnlyPaths).toEqual([actor.commandPath]);
    expect(config.readOnlyPaths).not.toContain("/private/tmp/unrelated-package/bin");
    expect(config.readOnlyPaths).not.toContain("/private/tmp/unrelated-package");
  });
});

describe("validateEvalWorkLogPath", () => {
  it("accepts a create-only controller path outside actor grants", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-work-log-path-"));
    const runDir = path.join(temp, "run");
    const logs = path.join(temp, "logs");
    await mkdir(runDir);
    await mkdir(logs);
    const target = path.join(logs, "eval.jsonl");
    await expect(validateEvalWorkLogPath(target, [runDir])).resolves.toBe(
      path.join(await realpath(logs), "eval.jsonl"),
    );
  });

  it("rejects an actor-visible work log", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-work-log-visible-"));
    const runDir = path.join(temp, "run");
    await mkdir(runDir);
    await expect(
      validateEvalWorkLogPath(path.join(runDir, "eval.jsonl"), [runDir]),
    ).rejects.toThrow(/actor-visible/i);
  });

  it("rejects a relative work log path", async () => {
    await expect(validateEvalWorkLogPath("eval.jsonl", [])).rejects.toThrow(/absolute/i);
  });
});

describe("public internet classification", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:192.168.1.2",
  ])("rejects local or special-use address %s", (address) => {
    expect(isPublicInternetAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts globally routable address %s",
    (address) => {
      expect(isPublicInternetAddress(address)).toBe(true);
    },
  );
});
