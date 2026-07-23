import { describe, expect, it } from "vitest";
import {
  assertStrictEvalReady,
  strictEvalReadinessErrors,
  WINDOWS_STRICT_ISOLATION_ERROR,
} from "./platform-readiness.js";

describe("strict eval platform readiness", () => {
  it("rejects Windows before an actor or ACL mutation can start", async () => {
    await expect(assertStrictEvalReady("win32")).rejects.toThrow(WINDOWS_STRICT_ISOLATION_ERROR);
    expect(await strictEvalReadinessErrors("win32")).toEqual([WINDOWS_STRICT_ISOLATION_ERROR]);
  });

  it("accepts macOS at the platform preflight", async () => {
    await expect(assertStrictEvalReady("darwin")).resolves.toBeUndefined();
  });
});
