import { describe, expect, it } from "vitest";
import { captureEvalProcess } from "./runner.js";

function actor(source: string): readonly [string, ...string[]] {
  return [process.execPath, "-e", source];
}

describe("eval process capture", () => {
  it("preserves stdout, stderr, exit status, and signal state", async () => {
    await expect(
      captureEvalProcess(
        actor("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
        process.cwd(),
        process.env,
        1_000,
      ),
    ).resolves.toMatchObject({ exitCode: 3, signal: null, stdout: "out", stderr: "err" });
  });

  it("returns a bounded timeout diagnostic and kills descendants holding inherited pipes", async () => {
    const started = performance.now();
    const result = await captureEvalProcess(
      actor(`
        const { spawn } = require("node:child_process");
        process.stdout.write("before-timeout");
        process.stderr.write("before-error");
        spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], { stdio: "inherit" });
        setInterval(() => {}, 10_000);
      `),
      process.cwd(),
      process.env,
      100,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("before-timeout");
    expect(result.stderr).toContain("before-error");
    expect(result.stderr).toContain("[EVAL_TIMEOUT]");
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it.skipIf(process.platform === "win32")(
    "reports containment failure when a direct child exits while a descendant retains pipes",
    async () => {
      const started = performance.now();
      const result = await captureEvalProcess(
        actor(`
        const { spawn } = require("node:child_process");
        spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "inherit" });
        process.stdout.write("early-output");
        process.exit(0);
      `),
        process.cwd(),
        process.env,
        1_000,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.containmentFailure).toBe(true);
      expect(result.stdout).toContain("early-output");
      expect(result.stderr).toContain("[EVAL_PROCESS_CONTAINMENT_FAILED]");
      expect(performance.now() - started).toBeLessThan(1_500);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not turn a late pipe close into a timeout after the child exits",
    async () => {
      const result = await captureEvalProcess(
        actor(`
          const { spawn } = require("node:child_process");
          spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "inherit" });
          setTimeout(() => process.exit(0), 700);
        `),
        process.cwd(),
        process.env,
        1_000,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.timedOut).toBeUndefined();
      expect(result.containmentFailure).toBe(true);
      expect(result.stderr).toContain("[EVAL_PROCESS_CONTAINMENT_FAILED]");
    },
  );

  it("forwards SIGINT to the launched process group and returns an interrupted failure", async () => {
    const resultPromise = captureEvalProcess(
      actor("process.stdout.write('live'); setInterval(() => {}, 10_000)"),
      process.cwd(),
      process.env,
      2_000,
    );
    setTimeout(() => process.emit("SIGINT"), 50);
    const result = await resultPromise;

    expect(result.exitCode).not.toBe(0);
    expect(result.interrupted).toBe("SIGINT");
    expect(result.stderr).toContain("[EVAL_INTERRUPTED]");
  });

  it("bounds excessive actor output and returns a stable nonzero diagnostic", async () => {
    const result = await captureEvalProcess(
      actor("process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))"),
      process.cwd(),
      process.env,
      2_000,
    );

    expect(result.exitCode).not.toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(4 * 1024 * 1024);
    expect(result.stderr).toContain("[EVAL_OUTPUT_LIMIT]");
  });

  it("keeps terminal diagnostics inside the stderr byte bound", async () => {
    const result = await captureEvalProcess(
      actor("process.stderr.write('x'.repeat(64 * 1024)); setInterval(() => {}, 10_000)"),
      process.cwd(),
      process.env,
      100,
    );

    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("[EVAL_TIMEOUT]");
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps decoded UTF-8 output inside the stdout byte bound", async () => {
    const result = await captureEvalProcess(
      actor(
        "process.stdout.write(Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 1, 120), Buffer.from([0xe2, 0x82])]));",
      ),
      process.cwd(),
      process.env,
      2_000,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[EVAL_OUTPUT_LIMIT]");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("does not hang while bounding malformed UTF-8 output", async () => {
    const result = await captureEvalProcess(
      actor(
        "process.stdout.write(Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 2, 120), Buffer.from([0x80, 0x80, 120])]));",
      ),
      process.cwd(),
      process.env,
      2_000,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[EVAL_OUTPUT_LIMIT]");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("reports a stable spawn diagnostic", async () => {
    await expect(
      captureEvalProcess(["/path/that/does/not/exist"], process.cwd(), process.env, 1_000),
    ).rejects.toThrow("[EVAL_SPAWN_FAILED]");
  });
});
