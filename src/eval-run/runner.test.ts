import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { nativeSandboxReadinessErrors } from "../sandbox/platform-readiness.js";
import { evalIsolatedPiHomeWritablePaths } from "./isolation.js";
import { buildEvalLaunchCommand, captureEvalProcess, runEvalCommand } from "./runner.js";

const { createTempDir } = registerManagedTempPaths();

function actor(source: string): readonly [string, ...string[]] {
  return [process.execPath, "-e", source];
}

/**
 * The actor must boot an interpreter and flush both pipes before this timeout fires, or the
 * pre-timeout markers never reach the controller and the case fails asserting them. Measured
 * boot-to-first-byte is about 36ms idle and up to 94ms under CPU contention, and a CI worker
 * is slower still, so the previous 100ms timeout could be consumed entirely by interpreter
 * startup. Keep this far above startup rather than close to it; see issue #36.
 */
const TIMEOUT_CAPTURE_TIMEOUT_MS = 2_000;

/** Loose upper bound on the whole capture: the timeout plus process-group teardown. */
const TIMEOUT_CAPTURE_BUDGET_MS = 6_000;

describe("eval process capture", () => {
  it("launches a symlinked executable through its lexical path", () => {
    expect(
      buildEvalLaunchCommand(
        { commandPath: "/bin/target", readPaths: ["/bin/launcher", "/bin/target"] },
        ["--flag"],
      ),
    ).toEqual(["/bin/launcher", "--flag"]);
  });

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
      TIMEOUT_CAPTURE_TIMEOUT_MS,
    );

    // Report exactly what arrived, so a failure distinguishes a marker lost to slow interpreter
    // startup from a genuinely broken capture path. See issue #36.
    const elapsedMs = performance.now() - started;
    const context = [
      `elapsed=${elapsedMs.toFixed(1)}ms`,
      `timedOut=${String(result.timedOut)}`,
      `exitCode=${String(result.exitCode)}`,
      `signal=${String(result.signal)}`,
      `stdout=${JSON.stringify(result.stdout.slice(0, 200))}`,
      `stderr=${JSON.stringify(result.stderr.slice(0, 200))}`,
      `platform=${process.platform}`,
    ].join(" ");
    if (elapsedMs > TIMEOUT_CAPTURE_BUDGET_MS / 2) {
      process.stderr.write(`[PIONEER_TEST_TIMING] eval timeout capture near budget: ${context}\n`);
    }

    expect(result.exitCode, context).not.toBe(0);
    expect(result.timedOut, context).toBe(true);
    expect(result.stdout, context).toContain("before-timeout");
    expect(result.stderr, context).toContain("before-error");
    expect(result.stderr, context).toContain("[EVAL_TIMEOUT]");
    expect(elapsedMs, context).toBeLessThan(TIMEOUT_CAPTURE_BUDGET_MS);
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

describe("eval isolated Pi credential locks", () => {
  it("exposes the isolated agent directory as writable scratch", () => {
    expect(
      evalIsolatedPiHomeWritablePaths({
        agentDir: "/tmp/control/pi-home/agent",
        homeDir: "/tmp/control/pi-home/home",
        tmpDir: "/tmp/control/pi-home/tmp",
      }),
    ).toEqual([
      "/tmp/control/pi-home/home",
      "/tmp/control/pi-home/tmp",
      "/tmp/control/pi-home/agent",
    ]);
  });

  it("lets a sandboxed actor create Pi credential lock directories beside snapshotted auth files", async (context) => {
    if ((await nativeSandboxReadinessErrors()).length > 0) {
      context.skip();
    }
    const root = await createTempDir("pioneer-eval-lock-");
    const runDir = path.join(root, "run");
    const piHome = path.join(root, "pi-home");
    const binDir = path.join(root, "bin");
    await mkdir(runDir);
    await mkdir(piHome);
    await mkdir(binDir);
    await writeFile(path.join(piHome, "auth.json"), '{"marker":"eval-auth-secret"}\n');
    await writeFile(path.join(piHome, "settings.json"), "{}\n");
    await writeFile(
      path.join(binDir, "pi"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.84.2; exit 0; fi\nif [ ! -d "$PI_CODING_AGENT_DIR" ]; then echo "No models available."; exit 0; fi\nprintf \'provider  model  context  max-out  thinking  images\\nsmoke  actor  1K  1K  no  no\\n\'\n',
      { mode: 0o755 },
    );
    const actor = path.join(binDir, "lock-actor");
    await writeFile(
      actor,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  process.stderr.write("missing-agent-dir\\n");
  process.exit(1);
}
for (const name of ["auth.json.lock", "settings.json.lock"]) {
  const lockDir = path.join(agentDir, name);
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), "eval-lock");
  } catch (error) {
    process.stderr.write("lock-failed:" + name + ":" + (error.code || error.message) + "\\n");
    process.exit(1);
  }
}
const auth = fs.readFileSync(path.join(agentDir, "auth.json"), "utf8");
if (!auth.includes("eval-auth-secret")) {
  process.stderr.write("auth-unreadable\\n");
  process.exit(1);
}
process.stdout.write("pi-credential-lock-ok\\n");
`,
      { mode: 0o755 },
    );

    const workLogPath = path.join(root, "eval.jsonl");
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const result = await runEvalCommand(
        {
          runDir,
          command: ["lock-actor"],
          piHomeSource: piHome,
        },
        // Keep the controller's scratch inside the managed root, so a cleanup regression is
        // caught by the run-root teardown instead of escaping to the operator's /tmp.
        { timeoutMs: 15_000, workLogPath, controllerScratchBase: root },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("pi-credential-lock-ok\n");
      expect(result.stderr).not.toMatch(/lock-failed|EPERM/);
      expect(result.workLogPath).toBe(path.join(await realpath(root), "eval.jsonl"));
      const stages = (await readFile(result.workLogPath ?? workLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; stage?: string });
      expect(stages.some((record) => record.stage === "pi_home_snapshot")).toBe(true);
      expect(stages.some((record) => record.stage === "isolation_probe")).toBe(true);
      expect(stages.some((record) => record.stage === "actor")).toBe(true);
      expect(stages.at(-1)?.type).toBe("eval_completed");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
