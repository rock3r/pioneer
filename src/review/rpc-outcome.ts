import { diagnosticMessage, sanitizeDiagnostic } from "../diagnostics.js";
import { stderrSummary } from "../stderr-summary.js";
import {
  type ClassifiedFailureCause,
  classifyFailureCause,
  type FailureCauseClass,
  type FailureCauseContext,
  formatFailureCause,
} from "./failure-cause.js";

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
  /** Provider and model the controller already resolved, never inferred from the prompt. */
  readonly providerContext?: FailureCauseContext;
}

const ASSISTANT_FAILURE_PREFIX = /^assistant stopReason=(?:error|aborted)(?::\s*(.*))?$/s;

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

function assistantFailureEvidence(diagnostics: readonly string[]): string | undefined {
  const details = diagnostics.flatMap((diagnostic) => {
    const detail = ASSISTANT_FAILURE_PREFIX.exec(diagnostic)?.[1]?.trim();
    return detail === undefined || detail.length === 0 ? [] : [detail];
  });
  return details.length === 0 ? undefined : details.join(" ");
}

/**
 * Attach the classified cause when Pi or stderr already supplied one. An empty
 * classification is omitted so a failure with no evidence stays unclassified
 * rather than growing a fabricated explanation.
 */
function withClassifiedCause(
  message: string,
  evidence: string | undefined,
  outcome: ReviewRpcOutcome,
  fallback: FailureCauseClass = "unclassified",
): string {
  if ((evidence === undefined || evidence.trim().length === 0) && fallback === "unclassified") {
    return message;
  }
  const classified = classifyReviewFailure(evidence, outcome, fallback);
  if (classified.cause === "unclassified" && classified.summary.length === 0) return message;
  return `${message} ${formatFailureCause(classified)}`;
}

export function classifyReviewFailure(
  evidence: string | undefined,
  outcome: Pick<ReviewRpcOutcome, "providerContext" | "sensitiveValues">,
  fallback: FailureCauseClass = "unclassified",
): ClassifiedFailureCause {
  const secrets = outcome.sensitiveValues ?? [];
  const captured = classifyFailureCause(evidence, {}, fallback).context;
  const capturedCode =
    captured.providerCode !== undefined &&
    secrets.some((secret) => secret.length > 0 && captured.providerCode?.includes(secret))
      ? undefined
      : captured.providerCode;
  const redacted =
    evidence === undefined || secrets.length === 0
      ? evidence
      : sanitizeDiagnostic(evidence, secrets);
  const classified = classifyFailureCause(redacted, outcome.providerContext, fallback);
  return {
    ...classified,
    context: {
      ...classified.context,
      ...(classified.context.status === undefined && captured.status !== undefined
        ? { status: captured.status }
        : {}),
      ...(classified.context.providerCode === undefined && capturedCode !== undefined
        ? { providerCode: capturedCode }
        : {}),
    },
  };
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
  const assistantEvidence = assistantFailureEvidence(outcome.diagnostics);
  if (outcome.completed && report) {
    if (outcome.exitCode === 0 && outcome.signal === null && assistantFailed) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_ASSISTANT_FAILED",
          withClassifiedCause(
            `Pi reported an assistant failure after producing partial review output (${context})`,
            assistantEvidence,
            outcome,
          ),
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
          withClassifiedCause(
            withFailedExitSummary(
              `Pi reported an assistant failure without a review report (${context})`,
              outcome,
            ),
            assistantEvidence,
            outcome,
          ),
        ),
      );
    }
    throw new Error(
      diagnosticMessage(
        "REVIEW_REPORT_MISSING",
        withClassifiedCause(
          withFailedExitSummary(`Pi settled without a review report (${context})`, outcome),
          undefined,
          outcome,
          "missing_report",
        ),
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
