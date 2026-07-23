import { describe, expect, it } from "vitest";
import { requestedPiModel } from "./pi-startup.js";

describe("requested Pi model extraction", () => {
  it("extracts a qualified model", () => {
    expect(requestedPiModel(["pi", "--model", "openai/gpt-5.5", "--mode", "rpc"])).toBe(
      "openai/gpt-5.5",
    );
  });

  it("qualifies an unqualified model with the explicit provider", () => {
    expect(requestedPiModel(["pi", "--model", "gpt-5.5:max", "--provider", "openai"])).toBe(
      "openai/gpt-5.5:max",
    );
  });

  it("supports equals-form model and provider options", () => {
    expect(requestedPiModel(["pi", "--provider=openai", "--model=gpt-5.5"])).toBe("openai/gpt-5.5");
  });

  it("returns undefined for non-Pi commands or the configured default", () => {
    expect(requestedPiModel(["node", "actor.mjs", "--model", "gpt-5.5"])).toBeUndefined();
    expect(requestedPiModel(["pi", "--mode", "rpc"])).toBeUndefined();
  });
});
