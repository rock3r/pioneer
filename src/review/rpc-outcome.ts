import { diagnosticMessage } from "../diagnostics.js";

interface ReviewRpcOutcome {
  readonly completed: boolean;
  readonly report: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly eventTypes: readonly string[];
  readonly diagnostics: readonly string[];
  readonly stderr: string;
  readonly sensitiveValues?: readonly string[];
}

export function completeReviewRpc(outcome: ReviewRpcOutcome): string {
  const report = outcome.report.trim();
  const context = `events: ${outcome.eventTypes.length}; diagnostics: ${outcome.diagnostics.length}; stderr: ${outcome.stderr.trim() ? "present" : "none"}`;
  const assistantFailed = outcome.diagnostics.some(
    (diagnostic) =>
      diagnostic.startsWith("assistant stopReason=error") ||
      diagnostic.startsWith("assistant stopReason=aborted"),
  );
  if (outcome.completed && report) {
    if (outcome.exitCode === 0 && outcome.signal === null && assistantFailed) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_ASSISTANT_FAILED",
          `Pi reported an assistant failure after producing partial review output (${context})`,
        ),
      );
    }
    if (outcome.exitCode === 0 && outcome.signal === null) return report;
    throw new Error(
      diagnosticMessage(
        "REVIEW_PROCESS_FAILED",
        `Pi exited unsuccessfully after settling (exit ${outcome.exitCode ?? "unknown"}; signal: ${outcome.signal ?? "none"}; ${context})`,
      ),
    );
  }
  if (outcome.completed) {
    if (assistantFailed) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_ASSISTANT_FAILED",
          `Pi reported an assistant failure without a review report (${context})`,
        ),
      );
    }
    throw new Error(
      diagnosticMessage("REVIEW_REPORT_MISSING", `Pi settled without a review report (${context})`),
    );
  }
  throw new Error(
    diagnosticMessage(
      "REVIEW_RPC_INCOMPLETE",
      `Pi exited before completing the review (exit ${outcome.exitCode ?? "unknown"}; ${context})`,
    ),
  );
}
