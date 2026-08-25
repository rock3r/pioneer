import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import {
  publishReservedReviewReport,
  type ReviewReportReservation,
} from "../review/report-output.js";
import type { DeepReviewConfigV1 } from "./config.js";
import { resolvedConfigLimits } from "./config.js";
import type { ArtifactFindingV1, PublishedFindingV1, SafeDiagnosticV1 } from "./consensus.js";
import type { PresidentOutcomeV1, WorkerOutcomeV1 } from "./result.js";

export interface DeepReviewResultV1 {
  readonly schemaVersion: "pioneer-deep-review-result/v1";
  readonly runId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly repositoryId?: string;
  };
  readonly pullRequest: { readonly number: number };
  readonly packetDigest: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly status: "complete" | "incomplete";
  readonly verdict: "clean" | "findings" | "unavailable";
  readonly workers: readonly WorkerOutcomeV1[];
  readonly president: PresidentOutcomeV1;
  readonly publishableFindings: readonly PublishedFindingV1[];
  readonly artifactFindings: readonly ArtifactFindingV1[];
  readonly diagnostics: readonly SafeDiagnosticV1[];
}

export interface PersistDeepReviewResultOptions {
  readonly result: DeepReviewResultV1;
  readonly resultPath: string;
  readonly reservation?: ReviewReportReservation;
}

export async function persistDeepReviewResult(
  options: PersistDeepReviewResultOptions,
): Promise<void> {
  const serialized = `${JSON.stringify(options.result, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] result exceeds size limit");
  }
  if (options.reservation !== undefined) {
    await publishReservedReviewReport(options.reservation, serialized.trimEnd());
    return;
  }
  const tempPath = `${options.resultPath}.pending-${randomUUID()}`;
  await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
  if (process.platform !== "win32") {
    await chmod(tempPath, 0o600);
  }
  const { rename } = await import("node:fs/promises");
  await rename(tempPath, options.resultPath);
}

export function buildTerminalSummary(result: DeepReviewResultV1): string {
  return JSON.stringify({
    schemaVersion: result.schemaVersion,
    runId: result.runId,
    status: result.status,
    verdict: result.verdict,
    publishableFindingCount: result.publishableFindings.length,
    headSha: result.headSha,
    packetDigest: result.packetDigest,
  });
}

export function deepReviewExitCode(result: DeepReviewResultV1): number {
  if (result.status !== "complete") return 2;
  if (result.verdict === "unavailable") return 2;
  if (result.verdict === "findings") return 1;
  return 0;
}

export function maximumModelOutputBytes(config: DeepReviewConfigV1): number {
  return resolvedConfigLimits(config).maximumModelOutputBytes;
}

const RESULT_KEYS = new Set([
  "schemaVersion",
  "runId",
  "repository",
  "pullRequest",
  "packetDigest",
  "baseSha",
  "headSha",
  "status",
  "verdict",
  "workers",
  "president",
  "publishableFindings",
  "artifactFindings",
  "diagnostics",
]);

export function parseDeepReviewResult(value: unknown): DeepReviewResultV1 {
  const context = "result";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RESULT_KEYS.has(key)) {
      throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} has unknown field ${key}`);
    }
  }
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== "pioneer-deep-review-result/v1") {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.schemaVersion is unsupported`);
  }
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.runId is required`);
  }
  if (typeof record.packetDigest !== "string" || record.packetDigest.length === 0) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.packetDigest is required`);
  }
  if (typeof record.baseSha !== "string" || typeof record.headSha !== "string") {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} SHAs are required`);
  }
  if (record.status !== "complete" && record.status !== "incomplete") {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.status is invalid`);
  }
  if (
    record.verdict !== "clean" &&
    record.verdict !== "findings" &&
    record.verdict !== "unavailable"
  ) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.verdict is invalid`);
  }
  if (typeof record.repository !== "object" || record.repository === null) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.repository is required`);
  }
  if (typeof record.pullRequest !== "object" || record.pullRequest === null) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context}.pullRequest is required`);
  }
  if (!Array.isArray(record.workers) || !Array.isArray(record.publishableFindings)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} arrays are required`);
  }
  if (!Array.isArray(record.artifactFindings) || !Array.isArray(record.diagnostics)) {
    throw new Error(`[DEEP_REVIEW_OUTPUT_INVALID] ${context} arrays are required`);
  }
  return record as unknown as DeepReviewResultV1;
}
