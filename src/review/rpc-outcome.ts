import { diagnosticMessage } from "../diagnostics.js";
import { stderrSummary } from "../stderr-summary.js";

interface ReviewRpcOutcome {
  readonly completed: boolean;
  readonly report: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly eventTypes: readonly string[];
  readonly diagnostics: readonly string[];
  readonly stderr: string;
  readonly sensitiveValues?: readonly string[];
  /** Staged extension packages; the summary names only these. */
  readonly extensionPackages?: ReadonlySet<string>;
}

function withStderrSummary(
  message: string,
  stderr: string,
  extensionPackages: ReadonlySet<string> | undefined,
): string {
  const summary = stderrSummary(stderr, extensionPackages);
  return summary ? `${message}. Pi stderr summary: ${summary}` : message;
}

/** A settled run that then exits nonzero or by signal may explain itself on stderr. */
function withFailedExitSummary(message: string, outcome: ReviewRpcOutcome): string {
  return outcome.exitCode === 0 && outcome.signal === null
    ? message
    : withStderrSummary(message, outcome.stderr, outcome.extensionPackages);
}

export function completeReviewRpc(outcome: ReviewRpcOutcome): string {
  if (outcome.diagnostics.includes("extension_error")) {
    throw new Error(
      "[REVIEW_EXTENSION_FAILED] An enabled Pi extension hook failed inside the review sandbox. Check its private-configuration, subprocess and proxy requirements before retrying; raw extension errors are suppressed to protect credentials.",
    );
  }
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
        withStderrSummary(
          `Pi exited unsuccessfully after settling (exit ${outcome.exitCode ?? "unknown"}; signal: ${outcome.signal ?? "none"}; ${context})`,
          outcome.stderr,
          outcome.extensionPackages,
        ),
      ),
    );
  }
  if (outcome.completed) {
    if (assistantFailed) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_ASSISTANT_FAILED",
          withFailedExitSummary(
            `Pi reported an assistant failure without a review report (${context})`,
            outcome,
          ),
        ),
      );
    }
    throw new Error(
      diagnosticMessage(
        "REVIEW_REPORT_MISSING",
        withFailedExitSummary(`Pi settled without a review report (${context})`, outcome),
      ),
    );
  }
  throw new Error(
    diagnosticMessage(
      "REVIEW_RPC_INCOMPLETE",
      withStderrSummary(
        `Pi exited before completing the review (exit ${outcome.exitCode ?? "unknown"}; ${context})`,
        outcome.stderr,
        outcome.extensionPackages,
      ),
    ),
  );
}
