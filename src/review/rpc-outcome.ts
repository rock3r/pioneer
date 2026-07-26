import { diagnosticMessage } from "../diagnostics.js";

interface ReviewRpcOutcome {
  readonly completed: boolean;
  readonly report: string;
  readonly exitCode: number | null;
  readonly eventTypes: readonly string[];
  readonly diagnostics: readonly string[];
  readonly stderr: string;
}

function summary(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function stderrSummary(stderr: string): string {
  return stderr.trim() || "none";
}

export function completeReviewRpc(outcome: ReviewRpcOutcome): string {
  const report = outcome.report.trim();
  if (outcome.completed && report) return report;
  const context = `events: ${summary(outcome.eventTypes)}; diagnostics: ${summary(outcome.diagnostics)}; stderr: ${stderrSummary(outcome.stderr)}`;
  if (outcome.completed) {
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
