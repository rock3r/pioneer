import { describe, expect, it } from "vitest";
import {
  DEFAULT_RPC_OUTPUT_BYTES,
  MAX_RPC_OUTPUT_BYTES,
  rpcOutputLimitDiagnostic,
  validateRpcOutputBytes,
  validateRpcOutputLimitMiB,
} from "./rpc-limits.js";

describe("review RPC output limits", () => {
  it("uses a 20 MiB default and accepts bounded integral overrides", () => {
    expect(validateRpcOutputLimitMiB(undefined)).toBe(DEFAULT_RPC_OUTPUT_BYTES);
    expect(DEFAULT_RPC_OUTPUT_BYTES).toBe(20 * 1024 * 1024);
    expect(validateRpcOutputLimitMiB(1)).toBe(1 * 1024 * 1024);
    expect(validateRpcOutputLimitMiB(64)).toBe(MAX_RPC_OUTPUT_BYTES);
  });

  it.each([0, -1, 1.5, 65, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid limit %s",
    (value) => {
      expect(() => validateRpcOutputLimitMiB(value)).toThrow(/1 through 64 MiB/i);
    },
  );

  it("formats a stable bounded diagnostic without provider content", () => {
    expect(rpcOutputLimitDiagnostic(20 * 1024 * 1024)).toBe(
      "[REVIEW_RPC_OUTPUT_LIMIT] Pi RPC output exceeded the 20 MiB limit",
    );
  });

  it("accepts byte-precise API overrides within the same MiB bounds", () => {
    expect(validateRpcOutputBytes(1 * 1024 * 1024 + 1)).toBe(1 * 1024 * 1024 + 1);
  });

  it("formats byte-precise overflow diagnostics without floating-point noise", () => {
    expect(rpcOutputLimitDiagnostic(20 * 1024 * 1024 + 1)).toBe(
      "[REVIEW_RPC_OUTPUT_LIMIT] Pi RPC output exceeded the 20971521 bytes limit",
    );
  });
});
