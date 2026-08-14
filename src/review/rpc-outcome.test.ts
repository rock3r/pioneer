import { describe, expect, it } from "vitest";
import { completeReviewRpc } from "./rpc-outcome.js";

describe("review RPC completion", () => {
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
        diagnostics: ["assistant stopReason=error: OAuth refresh failed"],
        stderr: "",
      }),
    ).toThrow(
      "[REVIEW_ASSISTANT_FAILED] Pi reported an assistant failure without a review report (events: agent_settled; diagnostics: assistant stopReason=error: OAuth refresh failed; stderr: none)",
    );
  });

  it("rejects partial output when Pi reports an assistant failure", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: "Partial review",
        exitCode: 0,
        signal: null,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: ["assistant stopReason=error: provider failed"],
        stderr: "",
      }),
    ).toThrow(
      "[REVIEW_ASSISTANT_FAILED] Pi reported an assistant failure after producing partial review output (events: message_end, agent_settled; diagnostics: assistant stopReason=error: provider failed; stderr: none)",
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
      "[REVIEW_RPC_INCOMPLETE] Pi exited before completing the review (exit 2; events: response; diagnostics: none; stderr: provider failed)",
    );
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
      "[REVIEW_PROCESS_FAILED] Pi exited unsuccessfully after settling (exit 2; signal: none; events: message_end, agent_settled; diagnostics: none; stderr: provider cleanup failed)",
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
    ).toThrow(/\[REDACTED\]/);

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
