import { describe, expect, it } from "vitest";

import { isThinkingLevel, THINKING_LEVELS } from "./thinking-level.js";

describe("thinking levels", () => {
  it("includes Pi's opt-in xhigh and max levels", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("rejects values outside Pi's public thinking-level contract", () => {
    expect(isThinkingLevel("max")).toBe(true);
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel(null)).toBe(false);
  });
});
