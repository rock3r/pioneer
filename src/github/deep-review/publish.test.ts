import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeGitHubClient } from "../../../test/support/fake-github-client.js";
import { registerManagedTempPaths } from "../../../test/support/temp-dir.js";
import type { PublishedFindingV1 } from "../../deep-review/consensus.js";
import { computeFindingIdFromFinding } from "../../deep-review/ids.js";
import { computePacketDigest } from "../../deep-review/packet.js";
import type { DeepReviewResultV1 } from "../../deep-review/result-output.js";
import { buildMarkerPayload, formatMarkerComment } from "./marker.js";
import { publishDeepReviewResult, startDeepReviewCheck } from "./publish.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function samplePacketBody() {
  return {
    schemaVersion: "pioneer-pr-review-packet/v1" as const,
    repository: { owner: "acme", name: "repo" },
    pullRequest: {
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
      title: "Fix",
      body: "",
      baseRef: "main",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    },
    commits: [{ sha: HEAD_SHA, title: "Fix", body: "" }],
    files: [
      {
        path: "src/main.ts",
        status: "modified" as const,
        contentKind: "text" as const,
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,3 @@\n line1\n+added2\n+added3\n",
      },
    ],
    rules: [],
    previousFindings: [],
  };
}

function sampleFinding(overrides: Partial<PublishedFindingV1> = {}): PublishedFindingV1 {
  const finding = {
    file: "src/main.ts",
    line: 2,
    endLine: 2,
    side: "RIGHT" as const,
    severity: "high" as const,
    category: "security" as const,
    title: "Unsafe input",
    summary: "Input is not validated.",
    evidence: "Line 3 passes raw input.",
    whyItMatters: "Remote code execution risk.",
    suggestedFix: "Validate and sanitize input.",
    confidence: "high" as const,
    dedupeKey: "unsafe-input",
    stableDedupeKey: "unsafe-input-stable",
    supportingCandidateIds: [`pdc_${"b".repeat(24)}`],
    supportingIndependenceGroups: ["group-a", "group-b"],
    presidentConfidence: "high" as const,
    ...overrides,
  };
  const findingId = computeFindingIdFromFinding(
    { owner: "acme", name: "repo" },
    1,
    HEAD_SHA,
    finding,
    finding.stableDedupeKey,
  );
  return { ...finding, findingId };
}

function sampleResult(
  publishableFindings: readonly PublishedFindingV1[],
  verdict: DeepReviewResultV1["verdict"] = "findings",
): DeepReviewResultV1 {
  const packetBody = samplePacketBody();
  const packetDigest = computePacketDigest(packetBody);
  return {
    schemaVersion: "pioneer-deep-review-result/v1",
    runId: "run-1",
    repository: { owner: "acme", name: "repo" },
    pullRequest: { number: 1 },
    packetDigest,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    status: "complete",
    verdict,
    workers: [],
    president: {
      memberId: "president",
      model: "openai/gpt-5",
      status: "success",
      clusterCount: publishableFindings.length,
    },
    publishableFindings,
    artifactFindings: [],
    diagnostics: [],
  };
}

async function writePublicationFixtures(
  tempDir: string,
  result: DeepReviewResultV1,
): Promise<{ resultPath: string; packetPath: string }> {
  const packetBody = samplePacketBody();
  const packetDigest = computePacketDigest(packetBody);
  const packetPath = path.join(tempDir, "packet.json");
  const resultPath = path.join(tempDir, "result.json");
  await writeFile(packetPath, `${JSON.stringify({ ...packetBody, packetDigest }, null, 2)}\n`, {
    flag: "wx",
  });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return { resultPath, packetPath };
}

describe("github deep-review publish", () => {
  const { createTempDir } = registerManagedTempPaths();
  it("posts no comments and fails check when head changed", async () => {
    const tempDir = await createTempDir("pioneer-publish-stale-");
    const finding = sampleFinding();
    const result = sampleResult([finding]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    let reviewCreated = false;
    const github = createFakeGitHubClient({
      getPullRequest: async () => ({
        number: 1,
        title: "Fix",
        body: "",
        htmlUrl: "https://github.com/acme/repo/pull/1",
        baseRef: "main",
        baseSha: BASE_SHA,
        headSha: "c".repeat(40),
      }),
      createPullRequestReview: async () => {
        reviewCreated = true;
        return { id: "300" };
      },
    });

    const outcome = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(outcome.conclusion).toBe("failure");
    expect(outcome.postedCount).toBe(0);
    expect(reviewCreated).toBe(false);
    expect(outcome.diagnostics.some((entry) => entry.id === "DEEP_REVIEW_HEAD_CHANGED")).toBe(true);
  });

  it("creates COMMENT review with single-line and multiline mappings", async () => {
    const tempDir = await createTempDir("pioneer-publish-create-");
    const single = sampleFinding({ line: 2, endLine: 2, stableDedupeKey: "single" });
    const multi = sampleFinding({
      line: 2,
      endLine: 3,
      stableDedupeKey: "multi",
      title: "Range issue",
    });
    const result = sampleResult([single, multi]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    let capturedReview: unknown;
    const github = createFakeGitHubClient({
      createPullRequestReview: async (input) => {
        capturedReview = input;
        return { id: "301" };
      },
    });

    const outcome = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(outcome.postedCount).toBe(2);
    expect(capturedReview).toMatchObject({
      event: "COMMENT",
      commitId: HEAD_SHA,
      comments: expect.arrayContaining([
        expect.objectContaining({ path: "src/main.ts", side: "RIGHT", line: 2 }),
        expect.objectContaining({
          path: "src/main.ts",
          side: "RIGHT",
          line: 3,
          startLine: 2,
          startSide: "RIGHT",
        }),
      ]),
    });
  });

  it("updates authenticated matching comments and skips human comments", async () => {
    const tempDir = await createTempDir("pioneer-publish-update-");
    const finding = sampleFinding();
    const marker = formatMarkerComment(
      buildMarkerPayload({
        repositoryOwner: "acme",
        repositoryName: "repo",
        pullRequestNumber: 1,
        findingId: finding.findingId,
        headSha: HEAD_SHA,
        path: finding.file,
        side: finding.side,
        line: finding.line,
        endLine: finding.endLine,
        category: finding.category,
      }),
    );
    const result = sampleResult([finding]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    const updates: string[] = [];
    const github = createFakeGitHubClient({
      listReviewComments: async () => [
        {
          id: "10",
          authorId: "99",
          authorLogin: "pioneer-bot",
          body: `Old body\n\n${marker}`,
          path: "src/main.ts",
          line: 2,
          side: "RIGHT",
        },
        {
          id: "11",
          authorId: "500",
          authorLogin: "human",
          body: "Please fix this",
          path: "src/main.ts",
          line: 2,
          side: "RIGHT",
        },
      ],
      updateReviewComment: async (_owner, _repo, commentId, body) => {
        updates.push(commentId);
        return {
          id: commentId,
          authorId: "99",
          authorLogin: "pioneer-bot",
          body,
        };
      },
      createPullRequestReview: async () => {
        throw new Error("should not create a new review when updating");
      },
    });

    const outcome = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(outcome.updatedCount).toBe(1);
    expect(outcome.postedCount).toBe(0);
    expect(updates).toEqual(["10"]);
  });

  it("publishes findings when a stale prior marker link cannot be reconciled", async () => {
    const tempDir = await createTempDir("pioneer-publish-stale-prior-");
    const priorFindingId = `pdr_${"d".repeat(24)}`;
    const staleHeadSha = "c".repeat(40);
    const finding = sampleFinding({ matchedPreviousFindingId: priorFindingId });
    const result = sampleResult([finding]);
    const packetBody = {
      ...samplePacketBody(),
      previousFindings: [
        {
          commentId: "50",
          authorId: "99",
          authorLogin: "pioneer-bot",
          body: "prior finding",
          path: "src/main.ts",
          line: 2,
          side: "RIGHT" as const,
          marker: {
            findingId: priorFindingId,
            headSha: staleHeadSha,
            path: "src/main.ts",
            side: "RIGHT" as const,
            line: 2,
            endLine: 2,
            category: "security" as const,
          },
          replies: [],
        },
      ],
    };
    const packetDigest = computePacketDigest(packetBody);
    const packetPath = path.join(tempDir, "packet.json");
    const resultPath = path.join(tempDir, "result.json");
    await writeFile(packetPath, `${JSON.stringify({ ...packetBody, packetDigest }, null, 2)}\n`, {
      flag: "wx",
    });
    await writeFile(resultPath, `${JSON.stringify({ ...result, packetDigest }, null, 2)}\n`, {
      flag: "wx",
    });

    let reviewCreated = false;
    const github = createFakeGitHubClient({
      createPullRequestReview: async () => {
        reviewCreated = true;
        return { id: "501" };
      },
    });

    const outcome = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(outcome.postedCount).toBe(1);
    expect(reviewCreated).toBe(true);
    expect(outcome.diagnostics.some((entry) => entry.id === "DEEP_REVIEW_OUTPUT_INVALID")).toBe(
      false,
    );
  });

  it("fails closed on duplicate authenticated markers", async () => {
    const tempDir = await createTempDir("pioneer-publish-dup-");
    const finding = sampleFinding();
    const marker = formatMarkerComment(
      buildMarkerPayload({
        repositoryOwner: "acme",
        repositoryName: "repo",
        pullRequestNumber: 1,
        findingId: finding.findingId,
        headSha: HEAD_SHA,
        path: finding.file,
        side: finding.side,
        line: finding.line,
        endLine: finding.endLine,
        category: finding.category,
      }),
    );
    const result = sampleResult([finding]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    let reviewCreated = false;
    const github = createFakeGitHubClient({
      listReviewComments: async () => [
        {
          id: "10",
          authorId: "99",
          authorLogin: "pioneer-bot",
          body: marker,
        },
        {
          id: "12",
          authorId: "99",
          authorLogin: "pioneer-bot",
          body: marker,
        },
      ],
      createPullRequestReview: async () => {
        reviewCreated = true;
        return { id: "400" };
      },
    });

    const outcome = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(outcome.conclusion).toBe("failure");
    expect(reviewCreated).toBe(false);
    expect(outcome.diagnostics.some((entry) => entry.id === "DEEP_REVIEW_MARKER_CONFLICT")).toBe(
      true,
    );
  });

  it("retries idempotently after partial success", async () => {
    const tempDir = await createTempDir("pioneer-publish-retry-");
    const finding = sampleFinding();
    const marker = formatMarkerComment(
      buildMarkerPayload({
        repositoryOwner: "acme",
        repositoryName: "repo",
        pullRequestNumber: 1,
        findingId: finding.findingId,
        headSha: HEAD_SHA,
        path: finding.file,
        side: finding.side,
        line: finding.line,
        endLine: finding.endLine,
        category: finding.category,
      }),
    );
    const result = sampleResult([finding]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    let createCount = 0;
    const github = createFakeGitHubClient({
      listReviewComments: async () => {
        if (createCount > 0) {
          return [
            {
              id: "20",
              authorId: "99",
              authorLogin: "pioneer-bot",
              body: `Published\n\n${marker}`,
              path: "src/main.ts",
              line: 2,
              side: "RIGHT",
            },
          ];
        }
        return [];
      },
      createPullRequestReview: async () => {
        createCount += 1;
        return { id: "500" };
      },
    });

    const first = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });
    const second = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(first.postedCount).toBe(1);
    expect(second.postedCount).toBe(0);
    expect(second.updatedCount).toBe(1);
    expect(createCount).toBe(1);
  });

  it("reconciles older in-progress checks on start", async () => {
    const updates: string[] = [];
    const github = createFakeGitHubClient({
      listCheckRunsForRef: async () => [
        {
          id: "old",
          name: "Pioneer deep review",
          status: "in_progress",
          headSha: HEAD_SHA,
        },
      ],
      updateCheckRun: async (input) => {
        updates.push(input.checkRunId);
        return {
          id: input.checkRunId,
          name: "Pioneer deep review",
          status: "completed" as const,
          headSha: HEAD_SHA,
          ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        };
      },
    });

    const started = await startDeepReviewCheck({
      owner: "acme",
      repo: "repo",
      headSha: HEAD_SHA,
      github,
    });

    expect(started.reconciledRunIds).toEqual(["old"]);
    expect(started.checkRunId).toBe("100");
    expect(updates).toContain("old");
  });

  it("completes the check run when publication inputs are missing", async () => {
    const tempDir = await createTempDir("publish-missing-");
    const packetPath = path.join(tempDir, "packet.json");
    await writeFile(packetPath, JSON.stringify(samplePacketBody()), "utf8");
    const resultPath = path.join(tempDir, "missing-result.json");

    let completed = false;
    const github = createFakeGitHubClient({
      updateCheckRun: async (input) => {
        if (input.status === "completed" && input.conclusion === "failure") {
          completed = true;
        }
        return {
          id: input.checkRunId,
          name: "Pioneer deep review",
          status: "completed" as const,
          headSha: HEAD_SHA,
          ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        };
      },
    });

    await expect(
      publishDeepReviewResult({
        owner: "acme",
        repo: "repo",
        pullNumber: 1,
        resultPath,
        packetPath,
        github,
        checkRunId: "100",
      }),
    ).rejects.toThrow();

    expect(completed).toBe(true);
  });

  it("completes the check run when GitHub publication fails mid-flight", async () => {
    const tempDir = await createTempDir("publish-github-failure-");
    const finding = sampleFinding();
    const result = sampleResult([finding]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    let completed = false;
    const github = createFakeGitHubClient({
      updateReviewComment: async () => {
        throw new Error("GitHub API unavailable");
      },
      listReviewComments: async () => [
        {
          id: "10",
          authorId: "99",
          authorLogin: "pioneer-bot",
          body: formatMarkerComment(
            buildMarkerPayload({
              repositoryOwner: "acme",
              repositoryName: "repo",
              pullRequestNumber: 1,
              findingId: finding.findingId,
              headSha: HEAD_SHA,
              path: finding.file,
              side: finding.side,
              line: finding.line,
              endLine: finding.endLine,
              category: finding.category,
            }),
          ),
          path: "src/main.ts",
          line: 2,
          side: "RIGHT",
        },
      ],
      updateCheckRun: async (input) => {
        if (input.status === "completed" && input.conclusion === "failure") {
          completed = true;
        }
        return {
          id: input.checkRunId,
          name: "Pioneer deep review",
          status: "completed" as const,
          headSha: HEAD_SHA,
          ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        };
      },
    });

    await expect(
      publishDeepReviewResult({
        owner: "acme",
        repo: "repo",
        pullNumber: 1,
        resultPath,
        packetPath,
        github,
        checkRunId: "100",
      }),
    ).rejects.toThrow("GitHub API unavailable");

    expect(completed).toBe(true);
  });

  it("skips unpublishable inline locations without aborting other findings", async () => {
    const tempDir = await createTempDir("pioneer-publish-location-");
    const invalid = sampleFinding({ line: 99, endLine: 99, stableDedupeKey: "invalid-line" });
    const valid = sampleFinding({ line: 2, endLine: 2, stableDedupeKey: "valid-line" });
    const result = sampleResult([invalid, valid]);
    const { resultPath, packetPath } = await writePublicationFixtures(tempDir, result);

    let reviewCreated = false;
    const github = createFakeGitHubClient({
      createPullRequestReview: async () => {
        reviewCreated = true;
        return { id: "600" };
      },
    });

    const outcome = await publishDeepReviewResult({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      resultPath,
      packetPath,
      github,
      checkRunId: "100",
    });

    expect(outcome.postedCount).toBe(1);
    expect(reviewCreated).toBe(true);
    expect(
      outcome.diagnostics.some((entry) => entry.id === "DEEP_REVIEW_LOCATION_UNPUBLISHABLE"),
    ).toBe(true);
  });
});
