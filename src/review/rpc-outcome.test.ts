import { describe, expect, it } from "vitest";
import { completeReviewRpc } from "./rpc-outcome.js";

describe("review RPC completion", () => {
  it("returns a non-empty report only after Pi settles", () => {
    expect(
      completeReviewRpc({
        completed: true,
        report: "  No findings.  ",
        exitCode: 0,
        eventTypes: ["message_end", "agent_settled"],
        diagnostics: [],
        stderr: "",
      }),
    ).toBe("No findings.");
  });

  it("fails with a stable diagnostic when Pi settles without a report", () => {
    expect(() =>
      completeReviewRpc({
        completed: true,
        report: " \n ",
        exitCode: 0,
        eventTypes: ["agent_settled"],
        diagnostics: ["assistant stopReason=error: OAuth refresh failed"],
        stderr: "",
      }),
    ).toThrow(
      "[REVIEW_REPORT_MISSING] Pi settled without a review report (events: agent_settled; diagnostics: assistant stopReason=error: OAuth refresh failed; stderr: none)",
    );
  });

  it("distinguishes an incomplete RPC session from a missing report", () => {
    expect(() =>
      completeReviewRpc({
        completed: false,
        report: "",
        exitCode: 2,
        eventTypes: ["response"],
        diagnostics: [],
        stderr: "provider failed",
      }),
    ).toThrow(
      "[REVIEW_RPC_INCOMPLETE] Pi exited before completing the review (exit 2; events: response; diagnostics: none; stderr: provider failed)",
    );
  });
});
