import { describe, expect, it } from "vitest";
import {
  parseClassifiedClusterV1,
  parsePresidentOutputV1,
  parseWorkerFindingV1,
  parseWorkerOutputV1,
} from "./finding.js";

describe("worker output", () => {
  it("parses valid worker output", () => {
    const output = parseWorkerOutputV1({
      schemaVersion: "pioneer-pr-review-worker/v1",
      findings: [
        {
          file: "src/a.ts",
          line: 1,
          endLine: 1,
          side: "RIGHT",
          severity: "high",
          category: "security",
          title: "Issue",
          summary: "Summary",
          evidence: "Evidence",
          whyItMatters: "Matters",
          suggestedFix: "Fix",
          confidence: "high",
          dedupeKey: "key-1",
        },
      ],
    });
    expect(output.findings).toHaveLength(1);
  });

  it("rejects unknown fields in finding", () => {
    expect(() =>
      parseWorkerFindingV1({
        file: "src/a.ts",
        line: 1,
        endLine: 1,
        side: "RIGHT",
        severity: "high",
        category: "security",
        title: "Issue",
        summary: "Summary",
        evidence: "Evidence",
        whyItMatters: "Matters",
        suggestedFix: "Fix",
        confidence: "high",
        dedupeKey: "key-1",
        reviewer: "fabricated",
      }),
    ).toThrow(/unknown field/);
  });

  it("rejects endLine before line", () => {
    expect(() =>
      parseWorkerFindingV1({
        file: "src/a.ts",
        line: 5,
        endLine: 3,
        side: "RIGHT",
        severity: "high",
        category: "security",
        title: "Issue",
        summary: "Summary",
        evidence: "Evidence",
        whyItMatters: "Matters",
        suggestedFix: "Fix",
        confidence: "high",
        dedupeKey: "key-1",
      }),
    ).toThrow(/endLine must be >= line/);
  });
});

describe("president output", () => {
  const baseFinding = {
    file: "src/a.ts",
    line: 1,
    endLine: 1,
    side: "RIGHT" as const,
    severity: "high" as const,
    category: "security" as const,
    title: "Issue",
    summary: "Summary",
    evidence: "Evidence",
    whyItMatters: "Matters",
    suggestedFix: "Fix",
    confidence: "high" as const,
    dedupeKey: "key-1",
  };

  it("parses accept cluster with required fields", () => {
    const cluster = parseClassifiedClusterV1({
      disposition: "accept",
      candidateIds: ["c1", "c2"],
      reason: "consensus-supported",
      rationale: "Agreed",
      normalizedFinding: baseFinding,
      presidentConfidence: "high",
      stableDedupeKey: "stable-key",
    });
    expect(cluster.disposition).toBe("accept");
  });

  it("rejects accept without normalizedFinding", () => {
    expect(() =>
      parseClassifiedClusterV1({
        disposition: "accept",
        candidateIds: ["c1"],
        reason: "consensus-supported",
        rationale: "Agreed",
        presidentConfidence: "high",
      }),
    ).toThrow(/normalizedFinding is required/);
  });

  it("rejects reject cluster with accept-only fields", () => {
    expect(() =>
      parseClassifiedClusterV1({
        disposition: "reject",
        candidateIds: ["c1"],
        reason: "singleton",
        rationale: "Only one",
        normalizedFinding: baseFinding,
        presidentConfidence: "high",
        stableDedupeKey: "stable-key",
      }),
    ).toThrow(/must not include accept-only fields/);
  });

  it("parses president output", () => {
    const output = parsePresidentOutputV1({
      schemaVersion: "pioneer-pr-review-president/v1",
      clusters: [
        {
          disposition: "reject",
          candidateIds: ["c1"],
          reason: "singleton",
          rationale: "Only one",
          presidentConfidence: "high",
        },
      ],
    });
    expect(output.clusters).toHaveLength(1);
  });
});
