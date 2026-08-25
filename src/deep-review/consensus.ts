import type { DeepReviewConfigV1 } from "./config.js";
import { computeMinimumSupport, resolvedPublishPolicy } from "./config.js";
import { findPacketFile, validateFindingLocation } from "./diff-location.js";
import type { ClassifiedClusterV1, FindingConfidenceV1, WorkerFindingV1 } from "./finding.js";
import { computeFindingIdFromFinding } from "./ids.js";
import type { PreviousFindingV1, PullRequestPacketV1 } from "./packet.js";

export interface CouncilMemberContext {
  readonly memberId: string;
  readonly model: string;
  readonly independenceGroup: string;
}

export interface CandidateRecord {
  readonly candidateId: string;
  readonly memberId: string;
  readonly independenceGroup: string;
  readonly finding: WorkerFindingV1;
}

export interface PublishedFindingV1 extends WorkerFindingV1 {
  readonly findingId: string;
  readonly stableDedupeKey: string;
  readonly supportingCandidateIds: readonly string[];
  readonly supportingIndependenceGroups: readonly string[];
  readonly presidentConfidence: FindingConfidenceV1;
  readonly matchedPreviousFindingId?: string;
}

export interface ArtifactFindingV1 {
  readonly candidateIds: readonly string[];
  readonly disposition: "rejected" | "not-publishable";
  readonly reason: string;
  readonly finding?: WorkerFindingV1;
}

export interface SafeDiagnosticV1 {
  readonly id: string;
  readonly severity: "warning" | "error";
  readonly message: string;
}

export function validateCandidatePartition(
  clusters: readonly ClassifiedClusterV1[],
  expectedCandidateIds: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const cluster of clusters) {
    for (const candidateId of cluster.candidateIds) {
      if (!expectedCandidateIds.has(candidateId)) {
        throw new Error(
          `[DEEP_REVIEW_CONSENSUS_INVALID] cluster references unknown candidate ${candidateId}`,
        );
      }
      if (seen.has(candidateId)) {
        throw new Error(
          `[DEEP_REVIEW_CONSENSUS_INVALID] candidate ${candidateId} appears in multiple clusters`,
        );
      }
      seen.add(candidateId);
    }
  }
  if (seen.size !== expectedCandidateIds.size) {
    throw new Error(`[DEEP_REVIEW_CONSENSUS_INVALID] cluster partition is incomplete`);
  }
}

function confidenceMeetsRequirement(
  confidence: FindingConfidenceV1,
  required: "high" | "medium",
): boolean {
  if (required === "high") return confidence === "high";
  return confidence === "high" || confidence === "medium";
}

function hasNonEmptyEvidenceFields(finding: WorkerFindingV1): boolean {
  return (
    finding.evidence.trim().length > 0 &&
    finding.whyItMatters.trim().length > 0 &&
    finding.suggestedFix.trim().length > 0
  );
}

export interface ApplyConsensusOptions {
  readonly config: DeepReviewConfigV1;
  readonly packet: PullRequestPacketV1;
  readonly clusters: readonly ClassifiedClusterV1[];
  readonly candidates: ReadonlyMap<string, CandidateRecord>;
}

export interface ConsensusResult {
  readonly publishableFindings: readonly PublishedFindingV1[];
  readonly artifactFindings: readonly ArtifactFindingV1[];
  readonly diagnostics: readonly SafeDiagnosticV1[];
}

export function applyConsensusGates(options: ApplyConsensusOptions): ConsensusResult {
  const { config, packet, clusters, candidates } = options;
  const minimumSupport = computeMinimumSupport(config);
  const publishPolicy = resolvedPublishPolicy(config);
  const maxPublished = config.limits?.maximumPublishedFindings ?? 10;

  const publishableFindings: PublishedFindingV1[] = [];
  const artifactFindings: ArtifactFindingV1[] = [];
  const diagnostics: SafeDiagnosticV1[] = [];
  const usedFindingIds = new Set<string>();

  for (const cluster of clusters) {
    if (cluster.disposition === "reject") {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "rejected",
        reason: cluster.reason,
        ...(cluster.normalizedFinding ? { finding: cluster.normalizedFinding } : {}),
      });
      continue;
    }

    const supporting = cluster.candidateIds
      .map((id) => candidates.get(id))
      .filter((record): record is CandidateRecord => record !== undefined);

    const groups = new Set(supporting.map((record) => record.independenceGroup));
    if (groups.size !== supporting.length) {
      diagnostics.push({
        id: "consensus-duplicate-group",
        severity: "error",
        message:
          "[DEEP_REVIEW_CONSENSUS_INVALID] accepted cluster has duplicate independence groups",
      });
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "duplicate-independence-group",
      });
      continue;
    }

    if (groups.size < minimumSupport) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "insufficient-support",
      });
      continue;
    }

    const normalized = cluster.normalizedFinding;
    const stableDedupeKey = cluster.stableDedupeKey;
    if (!normalized || !stableDedupeKey) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "missing-normalized-finding",
      });
      continue;
    }

    if (cluster.reason !== "consensus-supported") {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "invalid-accept-reason",
      });
      continue;
    }

    if (
      !confidenceMeetsRequirement(
        cluster.presidentConfidence,
        publishPolicy.requirePresidentConfidence,
      )
    ) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "president-confidence-too-low",
        finding: normalized,
      });
      continue;
    }

    if (
      !publishPolicy.publishSeverities.has(normalized.severity as "critical" | "high" | "medium")
    ) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "severity-not-publishable",
        finding: normalized,
      });
      continue;
    }

    if (!publishPolicy.publishCategories.has(normalized.category)) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "category-not-publishable",
        finding: normalized,
      });
      continue;
    }

    if (!hasNonEmptyEvidenceFields(normalized)) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "missing-evidence-fields",
        finding: normalized,
      });
      continue;
    }

    const packetFile = findPacketFile(packet.files, normalized.file);
    if (
      !packetFile ||
      !validateFindingLocation(packetFile, normalized.side, normalized.line, normalized.endLine)
    ) {
      artifactFindings.push({
        candidateIds: cluster.candidateIds,
        disposition: "not-publishable",
        reason: "invalid-location",
        finding: normalized,
      });
      continue;
    }

    const findingId = computeFindingIdFromFinding(
      packet.repository,
      packet.pullRequest.number,
      packet.pullRequest.headSha,
      normalized,
      stableDedupeKey,
    );

    if (usedFindingIds.has(findingId)) {
      throw new Error(`[DEEP_REVIEW_CONSENSUS_INVALID] finding ID collision: ${findingId}`);
    }
    usedFindingIds.add(findingId);

    publishableFindings.push({
      ...normalized,
      findingId,
      stableDedupeKey,
      supportingCandidateIds: cluster.candidateIds,
      supportingIndependenceGroups: [...groups],
      presidentConfidence: cluster.presidentConfidence,
      ...(cluster.matchedPreviousFindingId
        ? { matchedPreviousFindingId: cluster.matchedPreviousFindingId }
        : {}),
    });
  }

  if (publishableFindings.length > maxPublished) {
    throw new Error(`[DEEP_REVIEW_CONSENSUS_INVALID] publishable findings exceed cap`);
  }

  return { publishableFindings, artifactFindings, diagnostics };
}

export interface PriorMarkerReconciliationInput {
  readonly finding: WorkerFindingV1;
  readonly stableDedupeKey: string;
  readonly matchedPreviousFindingId?: string;
  readonly previousFindings: readonly PreviousFindingV1[];
  readonly headSha: string;
}

export function reconcilePriorFindingId(input: PriorMarkerReconciliationInput): string | undefined {
  const { finding, matchedPreviousFindingId, previousFindings, headSha } = input;
  if (!matchedPreviousFindingId) return undefined;

  const matches = previousFindings.filter(
    (previous) => previous.marker?.findingId === matchedPreviousFindingId,
  );
  if (matches.length !== 1) return undefined;

  const match = matches[0];
  const marker = match?.marker;
  if (!marker) return undefined;
  if (marker.headSha !== headSha) return undefined;
  if (marker.path !== finding.file || marker.side !== finding.side) return undefined;
  if (marker.category !== finding.category) return undefined;

  const overlaps = finding.line <= marker.endLine && finding.endLine >= marker.line;
  if (!overlaps) return undefined;

  return matchedPreviousFindingId;
}

export function countSuccessfulIndependenceGroups(
  members: readonly CouncilMemberContext[],
  successfulMemberIds: ReadonlySet<string>,
): number {
  const groups = new Set<string>();
  for (const member of members) {
    if (successfulMemberIds.has(member.memberId)) {
      groups.add(member.independenceGroup);
    }
  }
  return groups.size;
}

export function quorumAvailable(config: DeepReviewConfigV1, successfulGroupCount: number): boolean {
  return successfulGroupCount >= computeMinimumSupport(config);
}
