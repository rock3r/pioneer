import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PIONEER_CLI } from "./support/harness.js";

async function runPioneerCli(args: readonly string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PIONEER_CLI, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe("deep-review CLI contract", () => {
  it("advertises deep-review in primary help", async () => {
    const result = await runPioneerCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pioneer deep-review");
  });

  it("prints deep-review usage", async () => {
    const result = await runPioneerCli(["deep-review", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--packet FILE");
    expect(result.stdout).toContain("--config FILE");
  });

  it("rejects missing required options", async () => {
    const result = await runPioneerCli(["deep-review", "--source", process.cwd()]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  it("advertises github deep-review adapter usage", async () => {
    const result = await runPioneerCli(["github", "deep-review", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("collect");
    expect(result.stdout).toContain("publish");
  });
});
