import { describe, expect, it } from "vitest";
import type { PublishedFindingV1 } from "../../deep-review/consensus.js";
import { extractMarkerFromBody } from "./marker.js";
import {
  neutralizeMentions,
  renderFindingCommentBody,
  sanitizeFindingField,
  stripModelHtmlComments,
} from "./render.js";

function sampleFinding(overrides: Partial<PublishedFindingV1> = {}): PublishedFindingV1 {
  return {
    file: "src/main.ts",
    line: 4,
    endLine: 4,
    side: "RIGHT",
    severity: "high",
    category: "security",
    title: "Unsafe input",
    summary: "Input is not validated.",
    evidence: "Line 4 passes raw input.",
    whyItMatters: "Remote code execution risk.",
    suggestedFix: "Validate and sanitize input.",
    confidence: "high",
    dedupeKey: "unsafe-input",
    findingId: `pdr_${"a".repeat(24)}`,
    stableDedupeKey: "unsafe-input-stable",
    supportingCandidateIds: [`pdc_${"b".repeat(24)}`],
    supportingIndependenceGroups: ["group-a", "group-b"],
    presidentConfidence: "high",
    ...overrides,
  };
}

describe("github deep-review render", () => {
  it("strips model-supplied HTML comments and neutralizes mentions", () => {
    const text = "Ping <!-- secret --> @alice and @acme/security";
    expect(stripModelHtmlComments(text)).toBe("Ping  @alice and @acme/security");
    const neutralized = neutralizeMentions(sanitizeFindingField(text));
    expect(neutralized).not.toContain("@alice");
    expect(neutralized).toContain("@\u200balice");
    expect(neutralized).toContain("@\u200bacme/security");
  });

  it("renders bounded markdown with hidden provenance marker", () => {
    const body = renderFindingCommentBody({
      finding: sampleFinding(),
      repositoryOwner: "acme",
      repositoryName: "repo",
      pullRequestNumber: 3,
      headSha: "b".repeat(40),
    });
    expect(body).toContain("### Unsafe input");
    expect(body).toContain("Remote code execution risk.");
    const extracted = extractMarkerFromBody(body);
    expect(extracted.marker?.findingId).toBe(`pdr_${"a".repeat(24)}`);
    expect(extracted.marker?.side).toBe("RIGHT");
  });

  it("bounds rendered field length", () => {
    const longText = "x".repeat(10_000);
    const body = renderFindingCommentBody({
      finding: sampleFinding({ summary: longText }),
      repositoryOwner: "acme",
      repositoryName: "repo",
      pullRequestNumber: 3,
      headSha: "b".repeat(40),
    });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(body.includes("x".repeat(10_000))).toBe(false);
  });
});
