import { describe, expect, it } from "vitest";
import { diagnosticMessage, parseDiagnostic, sanitizeDiagnostic } from "./diagnostics.js";

describe("diagnostics", () => {
  it("bounds provider-controlled input before credential-label scans", () => {
    const input = `${"a-".repeat(8_000)}: x`;
    const startedAt = performance.now();
    const sanitized = sanitizeDiagnostic(input);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  it("removes zero-width format controls before credential matching", () => {
    const sanitized = sanitizeDiagnostic("to\u200Bken=private-value");
    expect(sanitized).not.toContain("private-value");
    expect(sanitized).toContain("token=[REDACTED]");
  });

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

  it("removes terminal controls before credential classification", () => {
    const sanitized = sanitizeDiagnostic(
      "api_\u001bkey=private-value\u0007 \u001b]52;c;clipboard\u0007 \u009b31mfailed",
    );

    expect(sanitized).not.toContain("private-value");
    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("\u0007");
    expect(sanitized).not.toContain("\u009b");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("preserves ported URL structure and ordinary at-sign diagnostics", () => {
    expect(
      sanitizeDiagnostic(
        "Request failed for https://user:password@example.test:443/path; password@host: message",
      ),
    ).toBe("Request failed for https://[REDACTED]@example.test:443/path; password@host: message");
  });

  it("redacts userinfo in protocol-relative URLs", () => {
    expect(sanitizeDiagnostic("Request failed for //user:private-password@example.test/path")).toBe(
      "Request failed for //[REDACTED]@example.test/path",
    );
  });

  it("redacts userinfo through the final at-sign in an authority", () => {
    expect(sanitizeDiagnostic("Request failed for https://user:p@ss@example.test/path")).toBe(
      "Request failed for https://[REDACTED]@example.test/path",
    );
  });

  it("stops authority redaction at compact JSON boundaries", () => {
    expect(
      sanitizeDiagnostic('{"url":"https://user:p@ss@example.test","email":"ops@example.test"}'),
    ).toBe('{"url":"https://[REDACTED]@example.test","email":"ops@example.test"}');
  });

  it("redacts valid punctuation inside URL userinfo", () => {
    expect(sanitizeDiagnostic("https://user:a,b@example.test/path")).toBe(
      "https://[REDACTED]@example.test/path",
    );
    expect(sanitizeDiagnostic("https://user:o'brien@example.test/path")).toBe(
      "https://[REDACTED]@example.test/path",
    );
  });

  it("redacts standalone AWS access key IDs", () => {
    expect(sanitizeDiagnostic("provider returned AKIAIOSFODNN7EXAMPLE")).toBe(
      "provider returned [REDACTED]",
    );
  });

  it("redacts standalone credentials adjacent to hyphens", () => {
    expect(
      sanitizeDiagnostic(
        "provider returned prefix-AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE-suffix",
      ),
    ).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts standalone Groq API keys", () => {
    const key = "gsk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    expect(sanitizeDiagnostic(`provider returned ${key}`)).not.toContain(key);
  });

  it("redacts standalone Hugging Face access tokens", () => {
    const token = "hf_abcdefghijklmnopqrstuvwxyzABCDEFGH";
    expect(sanitizeDiagnostic(`provider returned ${token}`)).not.toContain(token);
  });

  it("redacts standalone Slack app-level tokens", () => {
    const token = "xapp-1-A0123456789-0123456789012-0123456789012-abcdef0123456789abcdef0123456789";
    expect(sanitizeDiagnostic(`provider returned ${token}`)).not.toContain(token);
  });

  it("preserves public JSON fields after unquoted credential scalars", () => {
    for (const scalar of ["null", "true", "false", "403", "-1.5e2"]) {
      const sanitized = sanitizeDiagnostic(`{"api_key":${scalar},"status":403}`);
      expect(sanitized).toContain('"api_key"=[REDACTED],"status":403');
      expect(sanitized).not.toContain(`:${scalar},`);
    }
  });

  it("redacts standalone Google API keys", () => {
    for (const token of [
      "AIzaSyA1234567890bcdefghijklmnopqrstuvx",
      "AIzaSyA1234567890bcdefghijklmnopqrstuv-",
    ]) {
      expect(sanitizeDiagnostic(`provider returned ${token}`)).toBe("provider returned [REDACTED]");
    }
  });

  it("redacts standalone JWT access tokens", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(sanitizeDiagnostic(`provider returned ${token}`)).toBe("provider returned [REDACTED]");
  });

  it("redacts standalone Slack access tokens", () => {
    const token = "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx";
    expect(sanitizeDiagnostic(`provider returned ${token}`)).toBe("provider returned [REDACTED]");
  });

  it("redacts standalone GitLab access tokens", () => {
    const token = "glpat-0123456789abcdefghij";
    expect(sanitizeDiagnostic(`provider returned ${token}`)).toBe("provider returned [REDACTED]");
  });

  it("redacts standalone Stripe secret and restricted keys", () => {
    for (const token of [
      "sk_live_51M3abcdefghijklmnopqrstuvwxyz",
      "rk_test_51M3abcdefghijklmnopqrstuvwxyz",
    ]) {
      expect(sanitizeDiagnostic(`provider returned ${token}`)).toBe("provider returned [REDACTED]");
    }
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

  it("preserves indented diagnostic details after credential assignments", () => {
    expect(sanitizeDiagnostic("token=private-token\n  at provider.ts:10\nrequest failed")).toBe(
      "token=[REDACTED] at provider.ts:10 request failed",
    );
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

  it("redacts underscore-prefixed credential labels", () => {
    const sanitized = sanitizeDiagnostic('_api_key=private-one\n{"_access_token":"private-two"}');

    expect(sanitized).not.toContain("private-one");
    expect(sanitized).not.toContain("private-two");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
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

  it("preserves query metadata after generic credential parameters", () => {
    expect(
      sanitizeDiagnostic(
        "Request failed for https://example.test/o?api_key=private-key&status=403 with timeout",
      ),
    ).toBe("Request failed for https://example.test/o?api_key=[REDACTED]&status=403 with timeout");
  });

  it("redacts credentials with percent-encoded literal query labels", () => {
    expect(
      sanitizeDiagnostic(
        "Request failed for https://idp.test/callback?access%5Ftoken=private-token&status=403",
      ),
    ).toBe("Request failed for https://idp.test/callback?access%5Ftoken=[REDACTED]&status=403");
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

  it("redacts OAuth credentials in percent-encoded URL parameters", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fidp.test%2Fcallback%3Faccess_token%3Dprivate-token%26state%3Dpublic-state",
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain("%26state%3Dpublic-state");
  });

  it("redacts OAuth credentials in multiply percent-encoded nested URLs", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%253A%252F%252Fidp.test%252Fcallback%253Faccess_token%253Dprivate-token%2526state%253Dpublic-state",
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain("%2526state%253Dpublic-state");
  });

  it("redacts multiply percent-encoded credential labels in nested URLs", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%253A%252F%252Fidp.test%252Fcb%253Faccess%255Ftoken%253Dprivate-token",
    );

    expect(sanitized).not.toContain("private-token");
  });

  it("redacts OAuth credentials in percent-encoded URL fragments", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fidp.test%2Fcallback%23access_token%3Dprivate-token%26state%3Dpublic-state",
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain("%26state%3Dpublic-state");
  });

  it("redacts userinfo in percent-encoded URLs", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fuser%3Aprivate-password%40example.test%2Fcallback",
    );

    expect(sanitized).not.toContain("user%3Aprivate-password");
    expect(sanitized).toContain("https%3A%2F%2F[REDACTED]%40example.test%2Fcallback");
  });

  it("redacts userinfo in multiply percent-encoded URLs", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%253A%252F%252Fuser%253Aprivate-password%2540example.test%252F",
    );

    expect(sanitized).not.toContain("private-password");
    expect(sanitized).toContain("https%253A%252F%252F[REDACTED]%2540example.test%252F");
  });

  it("redacts URL userinfo when the terminator is encoded more deeply than the authority", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fuser%3Aprivate-password%2540example.test%2F",
    );

    expect(sanitized).not.toContain("private-password");
    expect(sanitized).toContain("https%3A%2F%2F[REDACTED]%2540example.test%2F");
  });

  it("redacts encoded userinfo containing deeper-encoded URL punctuation", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fuser%3Aprivate%252Fpassword%40example.test%2F",
    );

    expect(sanitized).not.toContain("private%252Fpassword");
    expect(sanitized).toContain("https%3A%2F%2F[REDACTED]%40example.test%2F");
  });

  it("redacts encoded userinfo behind literal authority slashes", () => {
    const sanitized = sanitizeDiagnostic("next=//user%3Aprivate-password%40example.test/path");

    expect(sanitized).not.toContain("private-password");
    expect(sanitized).toContain("//[REDACTED]%40example.test/path");
  });

  it("redacts literal userinfo delimiters behind encoded authority slashes", () => {
    const sanitized = sanitizeDiagnostic(
      "next=https%3A%2F%2Fuser:private-password@example.test/path",
    );

    expect(sanitized).not.toContain("private-password");
    expect(sanitized).toContain("https%3A%2F%2F[REDACTED]@example.test/path");
  });

  it("does not treat literal path emails as encoded-authority userinfo", () => {
    const diagnostic = "next=https%3A%2F%2Fexample.test/path/user@example.test";
    expect(sanitizeDiagnostic(diagnostic)).toBe(diagnostic);
  });

  it("redacts userinfo in percent-encoded protocol-relative URLs", () => {
    const sanitized = sanitizeDiagnostic(
      "next=%2F%2Fuser%3Aprivate-password%40example.test%2Fcallback",
    );

    expect(sanitized).not.toContain("user%3Aprivate-password");
    expect(sanitized).toContain("%2F%2F[REDACTED]%40example.test%2Fcallback");
  });

  it("bounds generic query redaction after HTML-escaped separators", () => {
    const sanitized = sanitizeDiagnostic(
      '{"url":"https://idp.test/?state=ok&amp;access_token=private","status":"failed","code":403}',
    );

    expect(sanitized).not.toContain("private");
    expect(sanitized).toContain('&amp;access_token=[REDACTED]","status":"failed","code":403');
  });

  it("redacts credentials after HTML-escaped assignment delimiters", () => {
    for (const delimiter of ["&#61;", "&#x3D;"]) {
      const sanitized = sanitizeDiagnostic(
        `https://idp.test/?access_token${delimiter}private-token&state=ok`,
      );

      expect(sanitized).not.toContain("private-token");
      expect(sanitized).toContain("&state=ok");
    }
  });

  it("bounds generic query redaction after Unicode-escaped separators", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{"url":"https://idp.test/?state=ok\u0026access_token=private","status":"failed","code":403}`,
    );

    expect(sanitized).not.toContain("private");
    expect(sanitized).toContain(
      String.raw`\u0026access_token=[REDACTED]","status":"failed","code":403`,
    );
  });

  it("bounds generic query redaction with Unicode-escaped assignment delimiters", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{"url":"https://idp.test/cb?access_token\u003dprivate-token","status":403}`,
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain(String.raw`access_token\u003d[REDACTED]","status":403`);
  });

  it("bounds generic query redaction with percent-encoded assignment delimiters", () => {
    const sanitized = sanitizeDiagnostic(
      '{"url":"https://idp.test/cb?access_token%3Dprivate-token%26state%3Dok","status":403}',
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain('access_token%3D[REDACTED]%26state%3Dok","status":403');
  });

  it("redacts multiply encoded labels and equals signs after literal query boundaries", () => {
    const sanitized = sanitizeDiagnostic(
      "https://idp.test/cb?access%255Ftoken%253Dprivate-token&state=ok",
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain("&state=ok");
  });

  it("redacts encoded ampersands that are data in literal query values", () => {
    const sanitized = sanitizeDiagnostic(
      "https://idp.test/cb?access_token=private%26suffix&state=ok",
    );

    expect(sanitized).not.toContain("private%26suffix");
    expect(sanitized).not.toContain("%26suffix");
    expect(sanitized).toContain("&state=ok");
  });

  it("bounds encoded query credentials with literal assignment delimiters", () => {
    const sanitized = sanitizeDiagnostic(
      '{"url":"https%3A%2F%2Fidp.test%2Fcb%3Faccess_token=private","status":"failed","code":403}',
    );

    expect(sanitized).not.toContain("private");
    expect(sanitized).toContain('"status":"failed","code":403');
  });

  it("redacts credentials after percent-encoded parameter separators", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{"url":"https://idp.test/cb?access_token%3Dprivate-one%26vault:api/key\u003dprivate-two%26state%3Dok","status":403}`,
    );

    expect(sanitized).not.toContain("private-one");
    expect(sanitized).not.toContain("private-two");
    expect(sanitized).toContain('%26state%3Dok","status":403');
  });

  it("redacts Unicode-escaped credential query labels", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{"url":"https://idp.test/cb?access\u005ftoken=private-token&state=ok","status":403}`,
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain(String.raw`access\u005ftoken=[REDACTED]&state=ok","status":403`);
  });

  it("does not swallow Unicode-escaped separators into query labels", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{"url":"https://idp.test/cb?public\u0026token=private-token","status":403}`,
    );

    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain(String.raw`?public\u0026token=[REDACTED]","status":403`);
  });

  it("bounds generic query redaction in literal URL fragments", () => {
    const sanitized = sanitizeDiagnostic(
      '{"url":"https://idp.test/cb#access_token=private&state=ok","status":403}',
    );

    expect(sanitized).not.toContain("private");
    expect(sanitized).toContain('#access_token=[REDACTED]&state=ok","status":403');
  });

  it("redacts credentials behind quoted JSON keys", () => {
    const sanitized = sanitizeDiagnostic(
      '{"api_key":"google-private","access_token":"access-private"}',
    );

    expect(sanitized).not.toContain("google-private");
    expect(sanitized).not.toContain("access-private");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts credentials behind Unicode-escaped JSON keys", () => {
    const sanitized = sanitizeDiagnostic(
      String.raw`{"api\u005fkey":"private-value","\u0061ccess_token":"private-leading"}`,
    );

    expect(sanitized).not.toContain("private-value");
    expect(sanitized).not.toContain("private-leading");
    expect(sanitized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts nested serialized Unicode-escaped credential keys", () => {
    const serialized = JSON.stringify(String.raw`{"api\u005fkey":"private-nested"}`);
    const sanitized = sanitizeDiagnostic(serialized);

    expect(sanitized).not.toContain("private-nested");
    expect(sanitized).toContain("[REDACTED]");
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
