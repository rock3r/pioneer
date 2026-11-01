import { describe, expect, it } from "vitest";
import { completeReviewRpc } from "./rpc-outcome.js";

describe("review RPC completion", () => {
  it("rejects an apparently complete report when an enabled extension hook failed", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "No findings",
        exitCode: 0,
        signal: null,
        eventTypes: ["extension_error", "agent_settled"],
        diagnostics: ["extension_error"],
        stderr: "private provider detail",
      }),
    ).toThrow("[REVIEW_EXTENSION_FAILED]");
  });
  it("returns a non-empty report only after Pi settles", () => {
    expect(
      completeReviewRpc({
        completed: true,
        report: "  No findings.  ",
        exitCode: 0,
        signal: null,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: [],
        stderr: "",
      }),
    ).toBe("No findings.");
  });

  it("fails with a stable diagnostic when Pi reports an assistant failure without a report", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: " \n ",
        exitCode: 0,
        signal: null,
        eventTypes: ["agent_settled"],
        diagnostics: ["assistant stopReason=error"],
        stderr: "",
      }),
    ).toThrow(
      "[REVIEW_ASSISTANT_FAILED] Pi reported an assistant failure without a review report (events: 1; diagnostics: 1; stderr: none)",
    );
  });

  it("surfaces a sanitized refresh-token cause with the resolved provider and model", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "",
        exitCode: 0,
        signal: null,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: [
          "assistant stopReason=error: Credential store modify failed for openai-codex: [PI_OAUTH_REFRESH_FAILED] Refresh through Pioneer failed. HTTP 401 code=refresh_token_reused",
        ],
        stderr: "",
        providerContext: { provider: "openai-codex", model: "gpt-6-astra" },
        sensitiveValues: ["private prompt"],
      }),
    ).toThrow(
      /\[REVIEW_ASSISTANT_FAILED\].*cause=auth_refresh; provider=openai-codex; model=gpt-6-astra;.*refresh_token_reused/,
    );
  });

  it("redacts a long caller secret before the cause summary is shortened", () => {
    const secret = `confidential acquisition ${"q".repeat(300)}`;
    let message = "";
    try {
      completeReviewRpc({
        completed: true,
        report: "",
        exitCode: 0,
        signal: null,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: [`assistant stopReason=error: provider failed after ${secret}`],
        stderr: "",
        sensitiveValues: [secret],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("confidential acquisition");
    expect(message).not.toContain("q".repeat(40));
  });

  it("does not restore a provider code that is itself a caller secret", () => {
    let message = "";
    try {
      completeReviewRpc({
        completed: true,
        report: "",
        exitCode: 0,
        signal: null,
        eventTypes: ["agent_settled"],
        diagnostics: ["assistant stopReason=error: provider failed code=confidential_acquisition"],
        stderr: "",
        sensitiveValues: ["confidential_acquisition"],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("code=confidential_acquisition");
    expect(message).not.toContain("confidential_acquisition");
  });

  it("names a missing report as incomplete rather than a successful review", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: " ",
        exitCode: 0,
        signal: null,
        eventTypes: ["agent_settled"],
        diagnostics: [],
        stderr: "",
      }),
    ).toThrow(/\[REVIEW_REPORT_MISSING\].*cause=missing_report.*not a completed review/);
  });

  it("rejects partial output when Pi reports an assistant failure", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "Partial review",
        exitCode: 0,
        signal: null,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: ["assistant stopReason=error"],
        stderr: "",
      }),
    ).toThrow(
      "[REVIEW_ASSISTANT_FAILED] Pi reported an assistant failure after producing partial review output (events: 2; diagnostics: 1; stderr: none)",
    );
  });

  it("distinguishes an incomplete RPC session from a missing report", () => {
    expect(() =>
      completeReviewRpc({
        completed: false,
        report: "",
        exitCode: 2,
        signal: null,
        eventTypes: ["response"],
        diagnostics: [],
        stderr: "provider failed",
      }),
    ).toThrow(
      "[REVIEW_RPC_INCOMPLETE] Pi exited before completing the review (exit 2; events: 1; diagnostics: 0; stderr: present)",
    );
  });

  it("names an allowlisted stderr summary when Pi exits early", () => {
    const stderr = [
      "Error: spawn EPERM token=sk-live-secret-value",
      "    at ChildProcess.spawn (node:internal/child_process:486:11)",
      "    at /private/tmp/pir-abc/extensions/tree/%2F/Users/someone/.pi/agent/npm/node_modules/pi-subagents/src/watchdog/diff-tool.js:32:37",
      "{",
      "  code: 'EPERM',",
      "  syscall: 'spawn'",
      "}",
    ].join("\n");
    let message = "";
    try {
      completeReviewRpc({
        completed: false,
        report: "",
        exitCode: 1,
        signal: null,
        eventTypes: ["extension_ui_request"],
        diagnostics: [],
        stderr,
        extensionPackages: new Set(["pi-subagents"]),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "[REVIEW_RPC_INCOMPLETE] Pi exited before completing the review (exit 1; events: 1; diagnostics: 0; stderr: present). Pi stderr summary: error=Error; code=EPERM; syscall=spawn; package=pi-subagents",
    );
  });

  it("adds the stderr summary when Pi settles without a report and then exits nonzero", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "",
        exitCode: 1,
        signal: null,
        eventTypes: ["agent_settled"],
        diagnostics: [],
        stderr: "TypeError: cleanup failed for hunter2",
      }),
    ).toThrow(
      /^\[REVIEW_REPORT_MISSING\] Pi settled without a review report \(events: 1; diagnostics: 0; stderr: present\)\. Pi stderr summary: error=TypeError cause=missing_report;/,
    );
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "",
        exitCode: 0,
        signal: null,
        eventTypes: ["agent_settled"],
        diagnostics: [],
        stderr: "Error: harmless",
      }),
    ).toThrow(/stderr: present\) cause=missing_report;/);
  });

  it("rejects a report when the settled Pi process exits nonzero", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "Partial report",
        exitCode: 2,
        signal: null,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: [],
        stderr: "provider cleanup failed",
      }),
    ).toThrow(
      "[REVIEW_PROCESS_FAILED] Pi exited unsuccessfully after settling (exit 2; signal: none; events: 2; diagnostics: 0; stderr: present)",
    );
  });

  it("redacts provider credentials and caller secrets from failure context", () => {
    expect(() =>
      completeReviewRpc({
        completed: false,
        report: "",
        exitCode: 2,
        signal: null,
        eventTypes: ["response"],
        diagnostics: ["assistant stopReason=error: token=provider-secret private prompt"],
        stderr: "Authorization: Bearer stderr-secret https://user:pass@example.test/private",
        sensitiveValues: ["private prompt"],
      }),
    ).toThrow(/events: 1; diagnostics: 1; stderr: present/);

    try {
      completeReviewRpc({
        completed: false,
        report: "",
        exitCode: 2,
        signal: null,
        eventTypes: ["response"],
        diagnostics: ["assistant stopReason=error: token=provider-secret private prompt"],
        stderr: "Authorization: Bearer stderr-secret https://user:pass@example.test/private",
        sensitiveValues: ["private prompt"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("provider-secret");
      expect(message).not.toContain("private prompt");
      expect(message).not.toContain("stderr-secret");
      expect(message).not.toContain("user:pass");
    }
  });
});
