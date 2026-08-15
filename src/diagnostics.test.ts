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

  it("preserves ported URL structure and ordinary at-sign diagnostics", () => {
    expect(
      sanitizeDiagnostic(
        "Request failed for https://user:password@example.test:443/path; password@host: message",
      ),
    ).toBe("Request failed for https://[REDACTED]@example.test:443/path; password@host: message");
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

  it("redacts folded Authorization field continuations", () => {
    const sanitized = sanitizeDiagnostic(
      "Authorization: Signature\r\n private-signature\r\nrequest failed",
    );

    expect(sanitized).toBe("Authorization=[REDACTED] request failed");
  });

  it("redacts folded generic credential header continuations", () => {
    expect(
      sanitizeDiagnostic("X-API-Key: private-prefix\r\n private-suffix\r\nrequest failed"),
    ).toBe("X-API-Key=[REDACTED] request failed");
  });

  it("preserves ordinary Windows UNC and device paths", () => {
    for (const path of [String.raw`\\server\share`, String.raw`\\?\C:\target`]) {
      expect(sanitizeDiagnostic(`Cannot read ${path}`)).toBe(`Cannot read ${path}`);
    }
  });

  it("preserves ordinary assignments whose labels merely end in credential words", () => {
    const diagnostic =
      "Request failed for https://example.test/?monkey=banana with signal=SIGTERM and status 404";

    expect(sanitizeDiagnostic(diagnostic)).toBe(diagnostic);
  });

  it("redacts provider-prefixed credential assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "GOOGLE_API_KEY=google-private\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=aws-private\nGITHUB_TOKEN=github-private",
    );

    expect(sanitized).toBe(
      "GOOGLE_API_KEY=[REDACTED] AWS_ACCESS_KEY_ID=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]",
    );
  });

  it("redacts cookie and session credential assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "Set-Cookie: session=private-cookie\nSESSION_ID=private-session\nsession_token=private-token",
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

  it("redacts camelCase connection-string assignments", () => {
    const sanitized = sanitizeDiagnostic(
      'azureConnectionString=private-azure\n{"redisConnectionString":"private-redis"}',
    );

    expect(sanitized).not.toContain("private-azure");
    expect(sanitized).not.toContain("private-redis");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts complete unquoted multiword credential values", () => {
    const sanitized = sanitizeDiagnostic(
      "PASSWORD=correct horse battery staple\nCLIENT_SECRET=multi word client secret\nrequest failed",
    );

    expect(sanitized).not.toContain("horse battery staple");
    expect(sanitized).not.toContain("multi word client secret");
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
    expect(sanitized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("preserves serialized fields after signed-URL credentials", () => {
    const sanitized = sanitizeDiagnostic(
      JSON.stringify({
        url: "https://blob.test/o?sig=private-signature",
        status: "failed",
        code: 403,
      }),
    );

    expect(sanitized).not.toContain("private-signature");
    expect(sanitized).toContain('"status":"failed"');
    expect(sanitized).toContain('"code":403');
  });

  it("redacts credentials in percent-encoded signed URLs", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fs3.test%2Fo%3FX-Amz-Credential%3Dprivate-access%26X-Amz-Signature%3Dprivate-signature%26X-Amz-Algorithm%3DAWS4-HMAC-SHA256",
    );

    expect(sanitized).not.toContain("private-access");
    expect(sanitized).not.toContain("private-signature");
    expect(sanitized).toContain("%26X-Amz-Algorithm%3DAWS4-HMAC-SHA256");
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
      '{"X-API-Key":"private-x-key","openai-api-key":"private-openai-key","vault@api_key":"private-at-key","vault+api_key":"private-plus-key"}',
    );

    expect(sanitized).not.toContain("private-x-key");
    expect(sanitized).not.toContain("private-openai-key");
    expect(sanitized).not.toContain("private-at-key");
    expect(sanitized).not.toContain("private-plus-key");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("redacts camelCase provider-prefixed credential keys", () => {
    const sanitized = sanitizeDiagnostic(
      '{"openaiApiKey":"private-openai-key","awsSecretAccessKey":"private-aws-key"}',
    );

    expect(sanitized).not.toContain("private-openai-key");
    expect(sanitized).not.toContain("private-aws-key");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts generic namespaced key assignments", () => {
    const sanitized = sanitizeDiagnostic(
      'AccountKey=private-account-key\nSECRETKEY=private-secret-key\n{"signingKey":"private-signing-key"}',
    );

    expect(sanitized).not.toContain("private-account-key");
    expect(sanitized).not.toContain("private-secret-key");
    expect(sanitized).not.toContain("private-signing-key");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts generic credential and signature assignments", () => {
    const sanitized = sanitizeDiagnostic(
      "credential=private-credential\nclient_credential=private-client\nsigningSignature=private-signature\npassword.confirm=private-confirmation",
    );

    expect(sanitized).not.toContain("private-credential");
    expect(sanitized).not.toContain("private-client");
    expect(sanitized).not.toContain("private-signature");
    expect(sanitized).not.toContain("private-confirmation");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("redacts credential assignments behind colon namespaces", () => {
    const sanitized = sanitizeDiagnostic("vault:token=private-token\nrequest failed");

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("request failed");
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

  it("preserves serialized fields after Authorization values", () => {
    const sanitized = sanitizeDiagnostic(
      JSON.stringify({ Authorization: "Basic private", status: "failed", code: 403 }),
    );

    expect(sanitized).not.toContain("Basic private");
    expect(sanitized).toContain('"status":"failed"');
    expect(sanitized).toContain('"code":403');
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
