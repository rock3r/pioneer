import { createHash } from "node:crypto";
import type { DiffSideV1, WorkerFindingV1 } from "./finding.js";

export function canonicalizeCandidate(value: WorkerFindingV1): string {
  return JSON.stringify({
    file: value.file,
    line: value.line,
    endLine: value.endLine,
    side: value.side,
    severity: value.severity,
    category: value.category,
    title: value.title,
    summary: value.summary,
    evidence: value.evidence,
    whyItMatters: value.whyItMatters,
    suggestedFix: value.suggestedFix,
    confidence: value.confidence,
    dedupeKey: value.dedupeKey,
  });
}

export function computeCandidateId(memberId: string, finding: WorkerFindingV1): string {
  const hash = createHash("sha256")
    .update(`${memberId}:${canonicalizeCandidate(finding)}`, "utf8")
    .digest("hex");
  return `pdc_${hash.slice(0, 24)}`;
}

export interface FindingIdInputs {
  readonly schemaVersion: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly file: string;
  readonly side: DiffSideV1;
  readonly line: number;
  readonly endLine: number;
  readonly category: string;
  readonly stableDedupeKey: string;
}

export function computeFindingId(inputs: FindingIdInputs): string {
  const payload = [
    inputs.schemaVersion,
    inputs.repositoryOwner,
    inputs.repositoryName,
    String(inputs.pullRequestNumber),
    inputs.headSha,
    inputs.file,
    inputs.side,
    String(inputs.line),
    String(inputs.endLine),
    inputs.category,
    inputs.stableDedupeKey,
  ].join("\0");
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  return `pdr_${hash.slice(0, 24)}`;
}

export function computeFindingIdFromFinding(
  repository: { owner: string; name: string },
  pullRequestNumber: number,
  headSha: string,
  finding: WorkerFindingV1,
  stableDedupeKey: string,
): string {
  return computeFindingId({
    schemaVersion: "pioneer-deep-review-result/v1",
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    pullRequestNumber,
    headSha,
    file: finding.file,
    side: finding.side,
    line: finding.line,
    endLine: finding.endLine,
    category: finding.category,
    stableDedupeKey,
  });
}
