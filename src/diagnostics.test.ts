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

  it("redacts complete parameterized Authorization fields regardless of scheme", () => {
    const sanitized = sanitizeDiagnostic(
      'Authorization: Signature keyId="private",algorithm="rsa-sha256",signature="credential"\nrequest failed',
    );

    expect(sanitized).toBe("Authorization=[REDACTED] request failed");
  });

  it("redacts provider-prefixed credential assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "GOOGLE_API_KEY=google-private AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=aws-private GITHUB_TOKEN=github-private",
    );

    expect(sanitized).toBe(
      "GOOGLE_API_KEY=[REDACTED] AWS_ACCESS_KEY_ID=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]",
    );
  });

  it("redacts cookie and session credential assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "Set-Cookie: session=private-cookie\nSESSION_ID=private-session session_token=private-token",
    );

    expect(sanitized).not.toContain("private-cookie");
    expect(sanitized).not.toContain("private-session");
    expect(sanitized).not.toContain("private-token");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts passphrase and connection-string assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "PASSPHRASE=correct horse battery staple\nCONNECTION_STRING=AccountName=x;AccountKey=private-key\nrequest failed",
    );

    expect(sanitized).not.toContain("horse battery staple");
    expect(sanitized).not.toContain("AccountKey=private-key");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(sanitized).toContain("request failed");
  });

  it("redacts unquoted passphrases revealed by serialized-key unescaping", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{\"passphrase\": correct horse battery staple}`,
    );

    expect(sanitized).not.toContain("horse battery staple");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts signed-URL query credentials", () => {
    const sanitized = sanitizeDiagnostic(
      "https://s3.test/object?X-Amz-Credential=private-access&X-Amz-Signature=private-signature https://storage.test/object?X-Goog-Credential=private-google&X-Goog-Signature=private-google-signature https://blob.test/object?sig=private-azure https://escaped.test/object?X-Amz-Algorithm=v\\u0026X-Amz-Credential=private-escaped\\u0026X-Amz-Signature=private-escaped-signature https://html.test/object?X-Amz-Algorithm=v&amp;X-Amz-Credential=private-html&amp;X-Amz-Signature=private-html-signature",
    );

    for (const secret of [
      "private-access",
      "private-signature",
      "private-google",
      "private-google-signature",
      "private-azure",
      "private-escaped",
      "private-escaped-signature",
      "private-html",
      "private-html-signature",
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(9);
  });

  it("redacts credentials behind quoted JSON keys", () => {
    const sanitized = sanitizeDiagnostic(
      '{"api_key":"google-private","access_token":"access-private"}',
    );

    expect(sanitized).not.toContain("google-private");
    expect(sanitized).not.toContain("access-private");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts hyphen-prefixed quoted credential keys", () => {
    const sanitized = sanitizeDiagnostic(
      '{"X-API-Key":"private-x-key","openai-api-key":"private-openai-key"}',
    );

    expect(sanitized).not.toContain("private-x-key");
    expect(sanitized).not.toContain("private-openai-key");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts camelCase provider-prefixed credential keys", () => {
    const sanitized = sanitizeDiagnostic(
      '{"openaiApiKey":"private-openai-key","awsSecretAccessKey":"private-aws-key"}',
    );

    expect(sanitized).not.toContain("private-openai-key");
    expect(sanitized).not.toContain("private-aws-key");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts credential fields behind nested JSON escaping", () => {
    const sanitized = sanitizeDiagnostic('{\\"api_key\\":\\"google-private\\"}');

    expect(sanitized).not.toContain("google-private");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts complete serialized credentials containing escaped quotes", () => {
    const sanitized = sanitizeDiagnostic(
      '{"password":"prefix\\"private leaked-suffix","status":"failed"}',
    );

    expect(sanitized).not.toContain("private");
    expect(sanitized).not.toContain("leaked-suffix");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("status");
  });

  it("redacts doubly serialized credentials containing escaped quotes", () => {
    const serialized = JSON.stringify(
      JSON.stringify({ password: 'prefix" private leaked-suffix', status: "failed" }),
    );
    const sanitized = sanitizeDiagnostic(serialized);

    expect(sanitized).not.toContain("private");
    expect(sanitized).not.toContain("leaked-suffix");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("status");
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

  it("preserves escaped ampersands while redacting exact caller secrets", () => {
    for (const secret of ["private&amp;value", "private\\u0026value"]) {
      expect(sanitizeDiagnostic(`failed ${secret}`, [secret])).toBe("failed [REDACTED]");
    }
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

  it("redacts quoted JSON Proxy-Authorization headers", () => {
    const sanitized = sanitizeDiagnostic('{"Proxy-Authorization":"Basic cHJveHk6c2VjcmV0"}');

    expect(sanitized).not.toContain("cHJveHk6c2VjcmV0");
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

  it("redacts complete PGP private-key armor blocks", () => {
    const sanitized = sanitizeDiagnostic(
      "PRIVATE_KEY=-----BEGIN PGP PRIVATE KEY BLOCK-----\\nprivate-material\\n-----END PGP PRIVATE KEY BLOCK----- request failed",
    );

    expect(sanitized).not.toContain("private-material");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("request failed");
  });
});
