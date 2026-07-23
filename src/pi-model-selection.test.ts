import { describe, expect, it } from "vitest";
import {
  configuredModelNames,
  type PiConfiguredModel,
  resolvePiModel,
  thinkingFromModelShorthand,
} from "./pi-model-selection.js";

const models: readonly PiConfiguredModel[] = [
  { provider: "anthropic", id: "claude-opus-4-1" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "openrouter", id: "gpt-5.5" },
];

describe("Pi model selection", () => {
  it("accepts an exact configured qualified model", () => {
    expect(resolvePiModel("openai/gpt-5.5", models)).toEqual({
      ok: true,
      qualifiedName: "openai/gpt-5.5",
    });
  });

  it("accepts a unique unqualified model and strips thinking shorthand", () => {
    expect(resolvePiModel("claude-opus-4-1:max", models)).toEqual({
      ok: true,
      qualifiedName: "anthropic/claude-opus-4-1",
    });
  });

  it("rejects an unavailable model and offers configured models", () => {
    const result = resolvePiModel("missing-model", models);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unavailable model resolution to fail");
    expect(result.error).toContain('Requested Pi model "missing-model" is not configured.');
    expect(result.error).toContain("anthropic/claude-opus-4-1");
    expect(result.error).toContain("openai/gpt-5.5");
  });

  it("rejects an ambiguous unqualified model and shows its qualified matches", () => {
    const result = resolvePiModel("gpt-5.5", models);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ambiguous model resolution to fail");
    expect(result.error).toContain('Requested Pi model "gpt-5.5" is ambiguous.');
    expect(result.error).toContain("openai/gpt-5.5");
    expect(result.error).toContain("openrouter/gpt-5.5");
    expect(result.error).toContain("Use a qualified provider/model name.");
  });

  it("formats the configured model catalog in stable provider/model order", () => {
    expect(configuredModelNames([...models].reverse())).toEqual([
      "anthropic/claude-opus-4-1",
      "openai/gpt-5.5",
      "openrouter/gpt-5.5",
    ]);
  });

  it("extracts max thinking without confusing provider model colons", () => {
    expect(thinkingFromModelShorthand("openai/gpt-5.5:max")).toBe("max");
    expect(thinkingFromModelShorthand("amazon/model:0")).toBeUndefined();
  });
});
