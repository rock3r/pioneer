import { describe, expect, it } from "vitest";
import { diagnosticMessage, parseDiagnostic, sanitizeDiagnostic } from "./diagnostics.js";

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

  it("redacts credential-shaped provider diagnostics and authenticated URLs", () => {
    const sanitized = sanitizeDiagnostic(
      'Authorization: Bearer secret-token access_token="refresh-me" https://user:password@example.test/path api_key=abc123 sk-projectedsecret',
    );

    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("refresh-me");
    expect(sanitized).not.toContain("user:password");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("sk-projectedsecret");
    expect(sanitized).toContain("[REDACTED]");
  });
});
