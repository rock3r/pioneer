import { describe, expect, it } from "vitest";
import {
  assertNativeSandboxReady,
  nativeSandboxReadinessErrors,
  WINDOWS_STRICT_ISOLATION_ERROR,
} from "./platform-readiness.js";

describe("native sandbox platform readiness", () => {
  it("rejects Windows before an actor or ACL mutation can start", async () => {
    await expect(assertNativeSandboxReady("win32")).rejects.toThrow(WINDOWS_STRICT_ISOLATION_ERROR);
    expect(await nativeSandboxReadinessErrors("win32")).toEqual([WINDOWS_STRICT_ISOLATION_ERROR]);
  });

  it("accepts macOS at the platform preflight", async () => {
    await expect(assertNativeSandboxReady("darwin")).resolves.toBeUndefined();
  });
});
