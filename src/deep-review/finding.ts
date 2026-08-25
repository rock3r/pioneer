import {
  assertNoExtraKeys,
  isRecord,
  optionalField,
  requireArray,
  requireEnum,
  requireNumber,
  requireRepoRelativePath,
  requireString,
} from "./validate.js";

export type FindingCategoryV1 =
  | "correctness"
  | "security"
  | "architecture"
  | "maintainability"
  | "test"
  | "docs"
  | "performance"
  | "ci";

export type FindingSeverityV1 = "critical" | "high" | "medium" | "low";
export type FindingConfidenceV1 = "high" | "medium" | "low";
export type DiffSideV1 = "LEFT" | "RIGHT";

export const FINDING_CATEGORIES = new Set<FindingCategoryV1>([
  "correctness",
  "security",
  "architecture",
  "maintainability",
  "test",
  "docs",
  "performance",
  "ci",
]);

export const FINDING_SEVERITIES = new Set<FindingSeverityV1>(["critical", "high", "medium", "low"]);

export const FINDING_CONFIDENCES = new Set<FindingConfidenceV1>(["high", "medium", "low"]);
export const DIFF_SIDES = new Set<DiffSideV1>(["LEFT", "RIGHT"]);

export interface WorkerFindingV1 {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly side: DiffSideV1;
  readonly severity: FindingSeverityV1;
  readonly category: FindingCategoryV1;
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly whyItMatters: string;
  readonly suggestedFix: string;
  readonly confidence: FindingConfidenceV1;
  readonly dedupeKey: string;
}

const WORKER_FINDING_KEYS = new Set([
  "file",
  "line",
  "endLine",
  "side",
  "severity",
  "category",
  "title",
  "summary",
  "evidence",
  "whyItMatters",
  "suggestedFix",
  "confidence",
  "dedupeKey",
]);

const MAX_FINDING_TEXT = 4_096;
const MAX_DEDUPE_KEY = 256;

export function parseWorkerFindingV1(value: unknown, context = "workerFinding"): WorkerFindingV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, WORKER_FINDING_KEYS, context);
  const line = requireNumber(value.line, "line", context, { integer: true, min: 1 });
  const endLine = requireNumber(value.endLine, "endLine", context, { integer: true, min: 1 });
  if (endLine < line) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.endLine must be >= line`);
  }
  return {
    file: requireRepoRelativePath(value.file, "file", context),
    line,
    endLine,
    side: requireEnum(value.side, "side", context, DIFF_SIDES),
    severity: requireEnum(value.severity, "severity", context, FINDING_SEVERITIES),
    category: requireEnum(value.category, "category", context, FINDING_CATEGORIES),
    title: requireString(value.title, "title", context, { maxLength: MAX_FINDING_TEXT }),
    summary: requireString(value.summary, "summary", context, { maxLength: MAX_FINDING_TEXT }),
    evidence: requireString(value.evidence, "evidence", context, { maxLength: MAX_FINDING_TEXT }),
    whyItMatters: requireString(value.whyItMatters, "whyItMatters", context, {
      maxLength: MAX_FINDING_TEXT,
    }),
    suggestedFix: requireString(value.suggestedFix, "suggestedFix", context, {
      maxLength: MAX_FINDING_TEXT,
    }),
    confidence: requireEnum(value.confidence, "confidence", context, FINDING_CONFIDENCES),
    dedupeKey: requireString(value.dedupeKey, "dedupeKey", context, { maxLength: MAX_DEDUPE_KEY }),
  };
}

export interface WorkerOutputV1 {
  readonly schemaVersion: "pioneer-pr-review-worker/v1";
  readonly findings: readonly WorkerFindingV1[];
}

const WORKER_OUTPUT_KEYS = new Set(["schemaVersion", "findings"]);

export function parseWorkerOutputV1(value: unknown): WorkerOutputV1 {
  const context = "workerOutput";
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, WORKER_OUTPUT_KEYS, context);
  const schemaVersion = requireString(value.schemaVersion, "schemaVersion", context);
  if (schemaVersion !== "pioneer-pr-review-worker/v1") {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.schemaVersion is unsupported`);
  }
  return {
    schemaVersion: "pioneer-pr-review-worker/v1",
    findings: requireArray(value.findings, "findings", context, (item) =>
      parseWorkerFindingV1(item, "workerOutput.findings[]"),
    ),
  };
}

export type PresidentRejectReasonV1 =
  | "singleton"
  | "insufficient-evidence"
  | "not-actionable"
  | "not-a-defect"
  | "nit-or-style"
  | "duplicate"
  | "conflicting-analysis"
  | "invalid-location"
  | "out-of-scope";

export type PresidentAcceptReasonV1 = "consensus-supported";

export type PresidentReasonV1 = PresidentAcceptReasonV1 | PresidentRejectReasonV1;

export const PRESIDENT_ACCEPT_REASONS = new Set<PresidentAcceptReasonV1>(["consensus-supported"]);
export const PRESIDENT_REJECT_REASONS = new Set<PresidentRejectReasonV1>([
  "singleton",
  "insufficient-evidence",
  "not-actionable",
  "not-a-defect",
  "nit-or-style",
  "duplicate",
  "conflicting-analysis",
  "invalid-location",
  "out-of-scope",
]);
export const PRESIDENT_REASONS = new Set<PresidentReasonV1>([
  ...PRESIDENT_ACCEPT_REASONS,
  ...PRESIDENT_REJECT_REASONS,
]);

export interface ClassifiedClusterV1 {
  readonly disposition: "accept" | "reject";
  readonly candidateIds: readonly string[];
  readonly reason: PresidentReasonV1;
  readonly rationale: string;
  readonly normalizedFinding?: WorkerFindingV1;
  readonly presidentConfidence: FindingConfidenceV1;
  readonly stableDedupeKey?: string;
  readonly matchedPreviousFindingId?: string;
}

const CLUSTER_KEYS = new Set([
  "disposition",
  "candidateIds",
  "reason",
  "rationale",
  "normalizedFinding",
  "presidentConfidence",
  "stableDedupeKey",
  "matchedPreviousFindingId",
]);

export function parseClassifiedClusterV1(value: unknown, context = "cluster"): ClassifiedClusterV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, CLUSTER_KEYS, context);
  const disposition = requireEnum(
    value.disposition,
    "disposition",
    context,
    new Set(["accept", "reject"] as const),
  );
  const reason = requireEnum(value.reason, "reason", context, PRESIDENT_REASONS);
  const normalizedFinding = optionalField(value, "normalizedFinding", (v) =>
    parseWorkerFindingV1(v, `${context}.normalizedFinding`),
  );
  const stableDedupeKey = optionalField(value, "stableDedupeKey", (v) =>
    requireString(v, "stableDedupeKey", context, { maxLength: MAX_DEDUPE_KEY }),
  );
  const matchedPreviousFindingId = optionalField(value, "matchedPreviousFindingId", (v) =>
    requireString(v, "matchedPreviousFindingId", context, { maxLength: 128 }),
  );

  if (disposition === "accept") {
    if (!PRESIDENT_ACCEPT_REASONS.has(reason as PresidentAcceptReasonV1)) {
      throw new Error(
        `[DEEP_REVIEW_OUTPUT_INVALID] ${context}.reason must be consensus-supported for accept`,
      );
    }
    if (!normalizedFinding) {
      throw new Error(
        `[DEEP_REVIEW_OUTPUT_INVALID] ${context}.normalizedFinding is required for accept`,
      );
    }
    if (!stableDedupeKey) {
      throw new Error(
        `[DEEP_REVIEW_OUTPUT_INVALID] ${context}.stableDedupeKey is required for accept`,
      );
    }
  } else {
    if (!PRESIDENT_REJECT_REASONS.has(reason as PresidentRejectReasonV1)) {
      throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.reason must be a reject reason`);
    }
    if (normalizedFinding || stableDedupeKey || matchedPreviousFindingId) {
      throw new Error(
        `[DEEP_REVIEW_OUTPUT_INVALID] ${context} reject cluster must not include accept-only fields`,
      );
    }
  }

  return {
    disposition,
    candidateIds: requireArray(value.candidateIds, "candidateIds", context, (item) =>
      requireString(item, "candidateIds[]", context, { maxLength: 128 }),
    ),
    reason,
    rationale: requireString(value.rationale, "rationale", context, {
      maxLength: MAX_FINDING_TEXT,
    }),
    ...(normalizedFinding ? { normalizedFinding } : {}),
    presidentConfidence: requireEnum(
      value.presidentConfidence,
      "presidentConfidence",
      context,
      FINDING_CONFIDENCES,
    ),
    ...(stableDedupeKey ? { stableDedupeKey } : {}),
    ...(matchedPreviousFindingId ? { matchedPreviousFindingId } : {}),
  };
}

export interface PresidentOutputV1 {
  readonly schemaVersion: "pioneer-pr-review-president/v1";
  readonly clusters: readonly ClassifiedClusterV1[];
}

const PRESIDENT_OUTPUT_KEYS = new Set(["schemaVersion", "clusters"]);

export function parsePresidentOutputV1(value: unknown): PresidentOutputV1 {
  const context = "presidentOutput";
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, PRESIDENT_OUTPUT_KEYS, context);
  const schemaVersion = requireString(value.schemaVersion, "schemaVersion", context);
  if (schemaVersion !== "pioneer-pr-review-president/v1") {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.schemaVersion is unsupported`);
  }
  return {
    schemaVersion: "pioneer-pr-review-president/v1",
    clusters: requireArray(value.clusters, "clusters", context, (item) =>
      parseClassifiedClusterV1(item, "presidentOutput.clusters[]"),
    ),
  };
}
