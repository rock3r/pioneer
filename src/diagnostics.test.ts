import { describe, expect, it } from "vitest";
import { diagnosticMessage, parseDiagnostic } from "./diagnostics.js";

describe("diagnostics", () => {
  it("embeds a stable ID in human-readable prose and parses it for machines", () => {
    const message = diagnosticMessage("PI_NOT_FOUND", "Install Pi and retry.");

    expect(message).toBe("[PI_NOT_FOUND] Install Pi and retry.");
    expect(parseDiagnostic(message)).toEqual({
      id: "PI_NOT_FOUND",
      severity: "error",
      message: "Install Pi and retry.",
    });
  });

  it("uses an explicit fallback ID for legacy unclassified errors", () => {
    expect(parseDiagnostic("legacy failure")).toEqual({
      id: "UNCLASSIFIED_ERROR",
      severity: "error",
      message: "legacy failure",
    });
  });
});
