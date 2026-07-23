import { describe, expect, it, vi } from "vitest";
import { checkPiReadiness, type PiProbeRunner } from "./pi-readiness.js";

const MODEL_LIST = [
  "provider    model       context  max-out  thinking  images",
  "openai      gpt-5.5     400K     128K     yes       yes",
  "openrouter  gpt-5.5     400K     128K     yes       yes",
  "anthropic   claude-opus 200K     64K      yes       yes",
  "",
].join("\n");

function configuredRunner(): PiProbeRunner {
  const results = [
    { exitCode: 0, stdout: "0.81.1\n", stderr: "" },
    { exitCode: 0, stdout: MODEL_LIST, stderr: "" },
  ];
  return vi.fn(async () => {
    const result = results.shift();
    if (result === undefined) throw new Error("Unexpected Pi probe");
    return result;
  });
}

describe("Pi requested-model readiness", () => {
  it("accepts a configured qualified model and strips thinking shorthand", async () => {
    await expect(
      checkPiReadiness({
        runner: configuredRunner(),
        requestedModel: "openai/gpt-5.5:max",
      }),
    ).resolves.toEqual({
      ready: true,
      version: "0.81.1",
      modelCount: 3,
      resolvedModel: "openai/gpt-5.5",
      errors: [],
    });
  });

  it("fails early when an unqualified model name is ambiguous", async () => {
    const result = await checkPiReadiness({
      runner: configuredRunner(),
      requestedModel: "gpt-5.5",
    });

    expect(result.ready).toBe(false);
    expect(result.errors[0]).toContain('Requested Pi model "gpt-5.5" is ambiguous');
    expect(result.errors[0]).toContain("- openai/gpt-5.5");
    expect(result.errors[0]).toContain("- openrouter/gpt-5.5");
  });

  it("fails early and offers the configured catalog for an unavailable model", async () => {
    const result = await checkPiReadiness({
      runner: configuredRunner(),
      requestedModel: "missing/model",
    });

    expect(result.ready).toBe(false);
    expect(result.errors[0]).toContain('Requested Pi model "missing/model" is not configured');
    expect(result.errors[0]).toContain("Configured Pi models:");
    expect(result.errors[0]).toContain("- anthropic/claude-opus");
  });
});
