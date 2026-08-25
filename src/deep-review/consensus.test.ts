import { describe, expect, it } from "vitest";
import { parseDeepReviewConfig } from "./config.js";
import type { CandidateRecord } from "./consensus.js";
import {
  applyConsensusGates,
  countSuccessfulIndependenceGroups,
  quorumAvailable,
  validateCandidatePartition,
} from "./consensus.js";
import {
  changedHunksForFile,
  findingRangeWithinSingleHunk,
  isGitHubPublishableLocation,
  mapToGitHubInlineComment,
  validateFindingLocation,
} from "./diff-location.js";
import type { WorkerFindingV1 } from "./finding.js";
import { computeCandidateId } from "./ids.js";
import type { PullRequestPacketV1 } from "./packet.js";
import { computePacketDigest } from "./packet.js";

const sampleFinding = (): WorkerFindingV1 => ({
  file: "src/main.ts",
  line: 2,
  endLine: 2,
  side: "RIGHT",
  severity: "high",
  category: "correctness",
  title: "Null dereference",
  summary: "Possible null access",
  evidence: "Line 2 accesses x without check",
  whyItMatters: "Runtime crash",
  suggestedFix: "Add null check",
  confidence: "high",
  dedupeKey: "null-deref-main",
});

function samplePacket(): PullRequestPacketV1 {
  const body = {
    schemaVersion: "pioneer-pr-review-packet/v1" as const,
    repository: { owner: "acme", name: "repo" },
    pullRequest: {
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
      title: "Fix",
      body: "",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    commits: [],
    files: [
      {
        path: "src/main.ts",
        status: "modified" as const,
        contentKind: "text" as const,
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
      },
    ],
    rules: [],
    previousFindings: [],
  };
  const packetDigest = computePacketDigest(body);
  return { ...body, packetDigest };
}

describe("consensus gates", () => {
  const config = parseDeepReviewConfig({
    schemaVersion: "pioneer-deep-review-config/v1",
    council: [
      { id: "a", model: "p/a", independenceGroup: "ga" },
      { id: "b", model: "p/b", independenceGroup: "gb" },
    ],
    president: { id: "p", model: "p/p", independenceGroup: "gp" },
  });

  it("accepts consensus-supported cluster with two groups", () => {
    const finding = sampleFinding();
    const candidates = new Map<string, CandidateRecord>([
      ["cand-a", { candidateId: "cand-a", memberId: "a", independenceGroup: "ga", finding }],
      ["cand-b", { candidateId: "cand-b", memberId: "b", independenceGroup: "gb", finding }],
    ]);
    const result = applyConsensusGates({
      config,
      packet: samplePacket(),
      clusters: [
        {
          disposition: "accept",
          candidateIds: ["cand-a", "cand-b"],
          reason: "consensus-supported",
          rationale: "Both agree",
          normalizedFinding: finding,
          presidentConfidence: "high",
          stableDedupeKey: "null-deref-main",
        },
      ],
      candidates,
    });
    expect(result.publishableFindings).toHaveLength(1);
    expect(result.publishableFindings[0]?.supportingIndependenceGroups).toEqual(["ga", "gb"]);
  });

  it("rejects singleton as not publishable", () => {
    const finding = sampleFinding();
    const candidates = new Map<string, CandidateRecord>([
      ["cand-a", { candidateId: "cand-a", memberId: "a", independenceGroup: "ga", finding }],
    ]);
    const result = applyConsensusGates({
      config,
      packet: samplePacket(),
      clusters: [
        {
          disposition: "reject",
          candidateIds: ["cand-a"],
          reason: "singleton",
          rationale: "Only one report",
          presidentConfidence: "high",
        },
      ],
      candidates,
    });
    expect(result.publishableFindings).toHaveLength(0);
    expect(result.artifactFindings[0]?.disposition).toBe("rejected");
  });

  it("rejects accept cluster with insufficient groups", () => {
    const finding = sampleFinding();
    const candidates = new Map<string, CandidateRecord>([
      ["cand-a", { candidateId: "cand-a", memberId: "a", independenceGroup: "ga", finding }],
    ]);
    const result = applyConsensusGates({
      config,
      packet: samplePacket(),
      clusters: [
        {
          disposition: "accept",
          candidateIds: ["cand-a"],
          reason: "consensus-supported",
          rationale: "Only one",
          normalizedFinding: finding,
          presidentConfidence: "high",
          stableDedupeKey: "key",
        },
      ],
      candidates,
    });
    expect(result.publishableFindings).toHaveLength(0);
    expect(result.artifactFindings[0]?.reason).toBe("insufficient-support");
  });

  it("validates total candidate partition", () => {
    expect(() =>
      validateCandidatePartition(
        [
          {
            disposition: "reject",
            candidateIds: ["c1"],
            reason: "singleton",
            rationale: "",
            presidentConfidence: "high",
          },
        ],
        new Set(["c1", "c2"]),
      ),
    ).toThrow(/incomplete/);
  });

  it("detects overlapping clusters", () => {
    expect(() =>
      validateCandidatePartition(
        [
          {
            disposition: "reject",
            candidateIds: ["c1"],
            reason: "singleton",
            rationale: "",
            presidentConfidence: "high",
          },
          {
            disposition: "reject",
            candidateIds: ["c1"],
            reason: "duplicate",
            rationale: "",
            presidentConfidence: "high",
          },
        ],
        new Set(["c1"]),
      ),
    ).toThrow(/multiple clusters/);
  });

  it("rejects fabricated candidate IDs", () => {
    expect(() =>
      validateCandidatePartition(
        [
          {
            disposition: "accept",
            candidateIds: ["fabricated-id"],
            reason: "consensus-supported",
            rationale: "",
            normalizedFinding: sampleFinding(),
            presidentConfidence: "high",
            stableDedupeKey: "key",
          },
        ],
        new Set(["c1"]),
      ),
    ).toThrow(/unknown candidate/);
  });
});

describe("quorum", () => {
  const config = parseDeepReviewConfig({
    schemaVersion: "pioneer-deep-review-config/v1",
    council: [
      { id: "a", model: "p/a", independenceGroup: "ga" },
      { id: "b", model: "p/b", independenceGroup: "gb" },
    ],
    president: { id: "p", model: "p/p", independenceGroup: "gp" },
  });

  it("requires both groups for two-group council", () => {
    expect(quorumAvailable(config, 1)).toBe(false);
    expect(quorumAvailable(config, 2)).toBe(true);
  });

  it("counts successful independence groups", () => {
    expect(
      countSuccessfulIndependenceGroups(
        [
          { memberId: "a", model: "p/a", independenceGroup: "ga" },
          { memberId: "b", model: "p/b", independenceGroup: "gb" },
        ],
        new Set(["a"]),
      ),
    ).toBe(1);
  });
});

describe("diff location", () => {
  const file = {
    path: "src/main.ts",
    status: "modified" as const,
    contentKind: "text" as const,
    additions: 1,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
  };

  it("validates RIGHT side on added line", () => {
    expect(validateFindingLocation(file, "RIGHT", 2, 2)).toBe(true);
  });

  it("rejects line outside hunk", () => {
    expect(validateFindingLocation(file, "RIGHT", 99, 99)).toBe(false);
  });

  it("maps single-line GitHub comment", () => {
    expect(mapToGitHubInlineComment("src/main.ts", "RIGHT", 2, 2)).toEqual({
      path: "src/main.ts",
      side: "RIGHT",
      line: 2,
    });
  });

  it("maps multiline GitHub comment", () => {
    expect(mapToGitHubInlineComment("src/main.ts", "RIGHT", 2, 4)).toEqual({
      path: "src/main.ts",
      side: "RIGHT",
      line: 4,
      startLine: 2,
      startSide: "RIGHT",
    });
  });

  it("rejects LEFT-side multiline GitHub publication", () => {
    const leftFile = {
      ...file,
      patch: "@@ -1,3 +1,3 @@\n-old1\n-old2\n-old3\n+new1\n+new2\n+new3\n",
    };
    expect(isGitHubPublishableLocation(leftFile, "LEFT", 1, 2)).toBe(false);
    expect(isGitHubPublishableLocation(leftFile, "LEFT", 1, 1)).toBe(true);
  });

  it("rejects multiline ranges spanning multiple hunks", () => {
    const multiHunkFile = {
      ...file,
      patch: "@@ -1,1 +1,2 @@\n context\n+added2\n@@ -10,1 +10,2 @@\n context10\n+added11\n",
    };
    expect(findingRangeWithinSingleHunk("RIGHT", 2, 11, changedHunksForFile(multiHunkFile))).toBe(
      false,
    );
    expect(isGitHubPublishableLocation(multiHunkFile, "RIGHT", 2, 11)).toBe(false);
    expect(isGitHubPublishableLocation(multiHunkFile, "RIGHT", 2, 2)).toBe(true);
  });
});

describe("candidate ids", () => {
  it("is deterministic for same member and finding", () => {
    const finding = sampleFinding();
    expect(computeCandidateId("worker-a", finding)).toBe(computeCandidateId("worker-a", finding));
    expect(computeCandidateId("worker-a", finding)).not.toBe(
      computeCandidateId("worker-b", finding),
    );
  });
});
