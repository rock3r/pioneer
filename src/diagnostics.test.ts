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

  it("redacts complete multi-token Authorization field values", () => {
    expect(sanitizeDiagnostic("Authorization: Basic dXNlcjpwYXNz\nrequest failed")).toBe(
      "Authorization=[REDACTED] request failed",
    );
    expect(
      sanitizeDiagnostic(
        'Authorization: Digest username="private", response="credential"\nrequest failed',
      ),
    ).toBe("Authorization=[REDACTED] request failed");
  });

  it("redacts serialized Digest authorization values with quoted fields", () => {
    const sanitized = sanitizeDiagnostic(
      '{"Authorization":"Digest username=\\"private\\", response=\\"credential\\""}',
    );

    expect(sanitized).not.toContain("private");
    expect(sanitized).not.toContain("credential");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts provider-prefixed credential assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "GOOGLE_API_KEY=google-private AWS_SECRET_ACCESS_KEY=aws-private GITHUB_TOKEN=github-private",
    );

    expect(sanitized).toBe(
      "GOOGLE_API_KEY=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]",
    );
  });

  it("redacts credentials behind quoted JSON keys", () => {
    const sanitized = sanitizeDiagnostic(
      '{"api_key":"google-private","access_token":"access-private"}',
    );

    expect(sanitized).not.toContain("google-private");
    expect(sanitized).not.toContain("access-private");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts credential fields behind nested JSON escaping", () => {
    const sanitized = sanitizeDiagnostic('{\\"api_key\\":\\"google-private\\"}');

    expect(sanitized).not.toContain("google-private");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts authenticated URLs with JSON-escaped slashes", () => {
    const sanitized = sanitizeDiagnostic("https:\\/\\/user:password@example.test/path");

    expect(sanitized).not.toContain("user:password");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts JSON-escaped sensitive values", () => {
    const prompt = "private first line\nprivate second line";
    const sanitized = sanitizeDiagnostic(`failed ${JSON.stringify(prompt)}`, [prompt]);

    expect(sanitized).toBe('failed "[REDACTED]"');
  });

  it("redacts quoted private-key fields", () => {
    const sanitized = sanitizeDiagnostic(
      '{"private_key":"-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----"}',
    );

    expect(sanitized).not.toContain("private-material");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts quoted JSON Authorization headers", () => {
    const sanitized = sanitizeDiagnostic('{"Authorization":"Basic dXNlcjpwYXNz"}');

    expect(sanitized).not.toContain("dXNlcjpwYXNz");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts complete unquoted private-key assignments", () => {
    for (const lineBreak of ["\n", "\\n"]) {
      const sanitized = sanitizeDiagnostic(
        `PRIVATE_KEY=-----BEGIN PRIVATE KEY-----${lineBreak}private-material${lineBreak}-----END PRIVATE KEY----- request failed`,
      );

      expect(sanitized).not.toContain("private-material");
      expect(sanitized).toContain("[REDACTED]");
      expect(sanitized).toContain("request failed");
    }
  });
});
