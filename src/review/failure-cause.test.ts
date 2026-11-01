import { describe, expect, it } from "vitest";
import { classifyFailureCause, formatFailureCause } from "./failure-cause.js";

const REFRESH_REUSED = [
  "Credential store modify failed for openai-codex: [PI_OAUTH_REFRESH_FAILED] Refresh through Pioneer failed; verify this provider in normal Pi.",
  'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {"error":{"message":"Your refresh token has already been used to generate a new access token. Please try signing in again.","type":"invalid_request_error","code":"refresh_token_reused"}}',
].join(" ");

describe("review failure cause", () => {
  it("surfaces a reused refresh token instead of an unclassified assistant failure", () => {
    const classified = classifyFailureCause(REFRESH_REUSED, {
      provider: "openai-codex",
      model: "gpt-6-astra",
      api: "openai-codex-responses",
    });

    expect(classified.cause).toBe("auth_refresh");
    expect(classified.context).toEqual({
      provider: "openai-codex",
      model: "gpt-6-astra",
      api: "openai-codex-responses",
      status: 401,
      providerCode: "refresh_token_reused",
    });
    expect(classified.guidance).toMatch(/re-authenticate/i);
    expect(classified.guidance).toMatch(/does not refresh|does not .* billing/i);

    const formatted = formatFailureCause(classified);
    expect(formatted).toContain("cause=auth_refresh");
    expect(formatted).toContain("provider=openai-codex");
    expect(formatted).toContain("model=gpt-6-astra");
    expect(formatted).toContain("status=401");
    expect(formatted).toContain("code=refresh_token_reused");
    expect(formatted).toContain("PI_OAUTH_REFRESH_FAILED");
    expect(formatted).not.toMatch(/sk-|Bearer [A-Za-z0-9]/);
  });

  it("keeps auth distinct from a missing credential and does not invent a provider", () => {
    const missing = classifyFailureCause("credentials_not_configured for openai");
    expect(missing.cause).toBe("missing_credentials");
    expect(missing.context.provider).toBe("openai");
    expect(missing.guidance).toMatch(/configure/i);
    expect(missing.guidance).not.toMatch(/re-authenticate/i);

    const absent = classifyFailureCause(undefined);
    expect(absent.cause).toBe("unclassified");
    expect(absent.summary).toBe("");
    expect(absent.context).toEqual({});
    expect(absent.guidance).toMatch(/no classified cause/i);
  });

  it("distinguishes quota, unsupported models, transport, timeout, and a missing report", () => {
    expect(classifyFailureCause("429 Too Many Requests: rate limit exceeded").cause).toBe(
      "quota_or_rate_limit",
    );
    expect(classifyFailureCause("The model `gpt-missing` was not found").cause).toBe(
      "unsupported_model",
    );
    expect(classifyFailureCause("fetch failed: connect ECONNREFUSED 127.0.0.1:1").cause).toBe(
      "transport",
    );
    expect(classifyFailureCause("Pi review timed out after 90000ms").cause).toBe(
      "timeout_or_cancellation",
    );
    expect(classifyFailureCause("request aborted by the caller").cause).toBe(
      "timeout_or_cancellation",
    );
  });

  it("does not treat an unrelated 401 or a file read as an auth failure", () => {
    const other = classifyFailureCause("provider returned HTTP 401 without a refresh diagnostic");
    expect(other.cause).toBe("unclassified");
    expect(other.context.status).toBe(401);
    expect(formatFailureCause(other)).not.toContain("cause=auth_refresh");
  });

  it("redacts a credential that the provider echoed into the diagnostic", () => {
    const classified = classifyFailureCause(
      "OAuth refresh failed (401): refresh_token_reused token=sk-live-secret-value",
    );
    expect(classified.cause).toBe("auth_refresh");
    expect(classified.summary).not.toContain("sk-live-secret-value");
    expect(formatFailureCause(classified)).not.toContain("sk-live-secret-value");
  });

  it("does not copy a prompt into the cause when the only evidence is the prompt", () => {
    const classified = classifyFailureCause(
      "Review PROPOSAL.md and mention token=sk-live-secret-value",
    );
    expect(classified.cause).toBe("unclassified");
    expect(classified.summary).not.toContain("sk-live-secret-value");
  });
});
