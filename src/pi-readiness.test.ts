import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkPiReadiness,
  PI_NO_MODELS_ERROR,
  PI_NOT_FOUND_ERROR,
  type PiConfigAccessProbe,
  type PiProbeRunner,
  piConfigSandboxError,
  piReadinessEnvironment,
} from "./pi-readiness.js";

function runnerWith(results: readonly Awaited<ReturnType<PiProbeRunner>>[]): PiProbeRunner {
  const remaining = [...results];
  return vi.fn(async () => {
    const result = remaining.shift();
    if (result === undefined) throw new Error("Unexpected Pi probe");
    return result;
  });
}

describe("Pi readiness", () => {
  const configuredAgentDir = path.resolve("/configured/pi-agent");
  it("passes cancellation to an in-flight Pi probe", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const runner: PiProbeRunner = async (_args, signal?: AbortSignal) => {
      observedSignal = signal;
      if (signal === undefined) {
        return await new Promise((resolve) =>
          setTimeout(() => resolve({ exitCode: null, stdout: "", stderr: "uncancelled" }), 50),
        );
      }
      return await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({ exitCode: null, stdout: "", stderr: "cancelled", errorCode: "ABORT_ERR" }),
          { once: true },
        );
      });
    };

    const readiness = checkPiReadiness({ runner, signal: controller.signal });
    controller.abort();

    await expect(readiness).resolves.toMatchObject({ ready: false });
    expect(observedSignal).toBe(controller.signal);
  });

  it("fails with installation instructions when Pi is not on PATH", async () => {
    const runner = runnerWith([{ exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" }]);

    await expect(checkPiReadiness({ runner })).resolves.toEqual({
      ready: false,
      modelCount: 0,
      errors: [PI_NOT_FOUND_ERROR],
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("fails with login instructions when Pi has no configured models", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
      {
        exitCode: 0,
        stdout: "No models available. Use /login to log into a provider via OAuth or API key.\n",
        stderr: "",
      },
    ]);

    const configAccessProbe = vi.fn<PiConfigAccessProbe>(async () => ({ status: "accessible" }));

    await expect(
      checkPiReadiness({
        runner,
        configAccessProbe,
        environment: { PI_CODING_AGENT_DIR: configuredAgentDir },
      }),
    ).resolves.toEqual({
      ready: false,
      version: "0.81.1",
      modelCount: 0,
      errors: [PI_NO_MODELS_ERROR],
    });
    expect(runner).toHaveBeenNthCalledWith(2, [
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--list-models",
    ]);
    expect(configAccessProbe).toHaveBeenCalledWith(configuredAgentDir);
  });

  it("rejects an old Pi before probing models", async () => {
    const runner = runnerWith([{ exitCode: 0, stdout: "0.80.5\n", stderr: "" }]);

    const result = await checkPiReadiness({ runner });

    expect(result).toMatchObject({
      ready: false,
      version: "0.80.5",
      modelCount: 0,
    });
    expect(result.errors).toEqual([
      "[PI_VERSION_TOO_OLD] Pi 0.80.5 is unsupported. Pioneer requires Pi 0.80.6 or newer. Update Pi and retry.",
    ]);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("warns but remains ready for a newer untested Pi", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.84.3\n", stderr: "" },
      {
        exitCode: 0,
        stdout:
          "provider  model       context  max-out  thinking  images\nopenai    gpt-5.5     400K     128K     yes       yes\n",
        stderr: "",
      },
    ]);

    const result = await checkPiReadiness({ runner });

    expect(result.ready).toBe(true);
    expect(result.warning).toContain("[PI_VERSION_UNTESTED]");
    expect(result.errors).toEqual([]);
  });

  it("remains ready for the tested maximum without a warning", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.84.2\n", stderr: "" },
      {
        exitCode: 0,
        stdout:
          "provider  model       context  max-out  thinking  images\nopenai    gpt-5.5     400K     128K     yes       yes\n",
        stderr: "",
      },
    ]);

    const result = await checkPiReadiness({ runner });

    expect(result.ready).toBe(true);
    expect(result.version).toBe("0.84.2");
    expect(result.warning).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it("identifies an outer agent sandbox without reading Pi configuration", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
      {
        exitCode: 0,
        stdout: "No models available. Use /login to log into a provider via OAuth or API key.\n",
        stderr: "",
      },
    ]);
    const configAccessProbe = vi.fn<PiConfigAccessProbe>(async () => ({
      status: "denied",
      errorCode: "EPERM",
    }));

    await expect(
      checkPiReadiness({
        runner,
        configAccessProbe,
        environment: { PI_CODING_AGENT_DIR: configuredAgentDir },
      }),
    ).resolves.toEqual({
      ready: false,
      version: "0.81.1",
      modelCount: 0,
      errors: [piConfigSandboxError(configuredAgentDir, "metadata access EPERM")],
    });
    expect(configAccessProbe).toHaveBeenCalledWith(configuredAgentDir);
  });

  it("treats an agent sandbox indicator as authoritative when access metadata is inconclusive", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
      { exitCode: 0, stdout: "No models available.\n", stderr: "" },
    ]);
    const configAccessProbe = vi.fn<PiConfigAccessProbe>(async () => ({ status: "accessible" }));

    const result = await checkPiReadiness({
      runner,
      configAccessProbe,
      environment: {
        PI_CODING_AGENT_DIR: configuredAgentDir,
        CODEX_PERMISSION_PROFILE: "workspace-write",
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("CODEX_PERMISSION_PROFILE");
    expect(result.errors[0]).toContain("did not read configuration contents");
    expect(result.errors[0]).toContain("escalated terminal");
  });

  it("accepts an installed Pi with configured models", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
      {
        exitCode: 0,
        stdout:
          "provider  model       context  max-out  thinking  images\nopenai    gpt-5.5     400K     128K     yes       yes\nanthropic claude-opus 200K     64K      yes       yes\n",
        stderr: "",
      },
    ]);

    await expect(checkPiReadiness({ runner })).resolves.toEqual({
      ready: true,
      version: "0.81.1",
      modelCount: 2,
      models: [
        { provider: "openai", id: "gpt-5.5" },
        { provider: "anthropic", id: "claude-opus" },
      ],
      errors: [],
    });
  });

  it("does not inherit outer-agent control state or provider secrets in Pi probe subprocesses", () => {
    const environment = piReadinessEnvironment({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: configuredAgentDir,
      OPENROUTER_API_KEY: "must-not-leak",
      OUTER_AGENT_PROJECT_ROOT: "/outer/project",
    });

    expect(environment).toMatchObject({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: configuredAgentDir,
    });
    expect(environment).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(environment).not.toHaveProperty("OUTER_AGENT_PROJECT_ROOT");
  });

  it("rejects a binary whose reported version does not match its CLI contract", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "Error: Unknown option: --no-approve\n" },
    ]);

    const result = await checkPiReadiness({ runner });

    expect(result.ready).toBe(false);
    expect(result.errors).toEqual([
      "[PI_CLI_INCOMPATIBLE] Pi 0.81.1 does not provide the required --no-approve project-trust control. Reinstall an official supported Pi release and verify that `pi --help` lists --no-approve.",
    ]);
  });

  it("rejects a partial catalog when Pi reports a broken models.json", async () => {
    const runner = runnerWith([
      { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
      {
        exitCode: 0,
        stdout:
          "provider  model       context  max-out  thinking  images\nopenai    gpt-5.5     400K     128K     yes       yes\n",
        stderr:
          'Warning: errors loading models.json: Failed to load models.json: Provider claude-code: "apiKey" is required when defining custom models.\n',
      },
    ]);

    const result = await checkPiReadiness({ runner });

    expect(result).toMatchObject({
      ready: false,
      version: "0.81.1",
      modelCount: 0,
      models: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("[PI_MODELS_CONFIG_INVALID]");
    expect(result.errors[0]).toContain("models.json");
    expect(result.errors[0]).not.toContain("apiKey");
  });

  it("reports an unusable Pi installation without leaking unbounded output", async () => {
    const runner = runnerWith([
      {
        exitCode: 1,
        stdout: "",
        stderr: `broken startup ${"x".repeat(2_000)}`,
      },
    ]);

    const result = await checkPiReadiness({ runner });
    expect(result.ready).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Pi could not start");
    expect(result.errors[0]?.length).toBeLessThan(700);
  });
});
