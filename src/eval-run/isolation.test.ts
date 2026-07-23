import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvalSandboxConfig,
  isPublicInternetAddress,
  validateEvalRunSpec,
} from "./isolation.js";

describe("validateEvalRunSpec", () => {
  it.skipIf(process.platform === "win32")(
    "canonicalizes the run directory and rejects broad runtime grants",
    async () => {
      const temp = await mkdtemp(path.join(tmpdir(), "pioneer-eval-"));
      const runDir = path.join(temp, "run");
      await mkdir(runDir);

      await expect(
        validateEvalRunSpec({
          runDir,
          command: ["/usr/bin/true"],
          runtimeReadPaths: ["/"],
        }),
      ).rejects.toThrow(/broad runtime read path/i);

      const spec = await validateEvalRunSpec({
        runDir,
        command: ["/usr/bin/true"],
        runtimeReadPaths: ["/usr"],
      });
      expect(spec.runDir).toBe(await realpath(runDir));
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
});

describe("cross-platform sandbox config", () => {
  it.each([
    ["darwin", "/", "/private/tmp/eval-run", ["/System", "/usr"]],
    ["linux", "/", "/tmp/eval-run", ["/usr", "/lib"]],
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
