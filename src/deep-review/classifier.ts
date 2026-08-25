import type { CouncilMemberV1, DeepReviewConfigV1 } from "./config.js";
import {
  type ArtifactFindingV1,
  applyConsensusGates,
  type CandidateRecord,
  type PublishedFindingV1,
  type SafeDiagnosticV1,
  validateCandidatePartition,
} from "./consensus.js";
import type { PresidentOutputV1 } from "./finding.js";
import type { PullRequestPacketV1 } from "./packet.js";
import type { PresidentOutcomeV1 } from "./result.js";

export interface PresidentClassificationInput {
  readonly config: DeepReviewConfigV1;
  readonly packet: PullRequestPacketV1;
  readonly candidates: ReadonlyMap<string, CandidateRecord>;
  readonly presidentOutput: PresidentOutputV1;
}

export interface PresidentClassificationResult {
  readonly publishableFindings: readonly PublishedFindingV1[];
  readonly artifactFindings: readonly ArtifactFindingV1[];
  readonly diagnostics: readonly SafeDiagnosticV1[];
  readonly clusterCount: number;
}

export function classifyPresidentOutput(
  input: PresidentClassificationInput,
): PresidentClassificationResult {
  validateCandidatePartition(input.presidentOutput.clusters, new Set(input.candidates.keys()));
  const consensus = applyConsensusGates({
    config: input.config,
    packet: input.packet,
    clusters: input.presidentOutput.clusters,
    candidates: input.candidates,
  });
  return {
    ...consensus,
    clusterCount: input.presidentOutput.clusters.length,
  };
}

export function successfulPresidentOutcome(
  member: CouncilMemberV1,
  clusterCount: number,
): PresidentOutcomeV1 {
  return {
    memberId: member.id,
    model: member.model,
    status: "success",
    clusterCount,
  };
}

export function failedPresidentOutcome(
  member: CouncilMemberV1,
  status: "not-run" | "failed" | "timed-out" | "output-invalid",
  diagnosticId: string,
): PresidentOutcomeV1 {
  return {
    memberId: member.id,
    model: member.model,
    status,
    diagnosticId,
  };
}
