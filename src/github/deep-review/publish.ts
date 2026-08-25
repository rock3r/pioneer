import { readFile } from "node:fs/promises";
import type { PublishedFindingV1 } from "../../deep-review/consensus.js";
import { reconcilePriorFindingId } from "../../deep-review/consensus.js";
import {
  findPacketFile,
  isGitHubPublishableLocation,
  mapToGitHubInlineComment,
} from "../../deep-review/diff-location.js";
import { computeFindingIdFromFinding } from "../../deep-review/ids.js";
import { type PullRequestPacketV1, parsePullRequestPacket } from "../../deep-review/packet.js";
import type { DeepReviewResultV1 } from "../../deep-review/result-output.js";
import { parseDeepReviewResult } from "../../deep-review/result-output.js";
import {
  DEEP_REVIEW_CHECK_NAME,
  type GitHubClient,
  type InlineReviewCommentInput,
} from "./client.js";
import { extractMarkerFromBody } from "./marker.js";
import { renderFindingCommentBody } from "./render.js";

export interface PublishDeepReviewOptions {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly resultPath: string;
  readonly packetPath: string;
  readonly github: GitHubClient;
  readonly checkRunId: string;
  readonly workflowRunUrl?: string;
  readonly artifactUrl?: string;
}

export interface PublishDeepReviewOutcome {
  readonly conclusion: "success" | "failure";
  readonly postedCount: number;
  readonly updatedCount: number;
  readonly diagnostics: readonly { readonly id: string; readonly message: string }[];
}

const MAX_PUBLISHED_FINDINGS = 10;
const SKIPPABLE_PUBLICATION_DIAGNOSTICS = new Set([
  "DEEP_REVIEW_LOCATION_INVALID",
  "DEEP_REVIEW_LOCATION_UNPUBLISHABLE",
]);

export async function readValidatedPublicationInputs(
  resultPath: string,
  packetPath: string,
): Promise<{ readonly result: DeepReviewResultV1; readonly packet: PullRequestPacketV1 }> {
  const [resultRaw, packetRaw] = await Promise.all([
    readFile(resultPath, "utf8"),
    readFile(packetPath, "utf8"),
  ]);
  const result = parseDeepReviewResult(JSON.parse(resultRaw) as unknown);
  const packet = parsePullRequestPacket(JSON.parse(packetRaw) as unknown);
  if (result.packetDigest !== packet.packetDigest) {
    throw new Error("[DEEP_REVIEW_PACKET_INVALID] result packetDigest does not match packet file");
  }
  return { result, packet };
}

export function validatePublicationContext(
  result: DeepReviewResultV1,
  packet: PullRequestPacketV1,
  owner: string,
  repo: string,
  pullNumber: number,
): void {
  if (result.status !== "complete") {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] deep review result is incomplete");
  }
  if (result.repository.owner !== owner || result.repository.name !== repo) {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] result repository does not match invocation");
  }
  if (result.pullRequest.number !== pullNumber) {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] result pull request does not match invocation");
  }
  if (result.headSha !== packet.pullRequest.headSha) {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] result head SHA does not match packet");
  }
  if (result.publishableFindings.length > MAX_PUBLISHED_FINDINGS) {
    throw new Error("[DEEP_REVIEW_CONSENSUS_INVALID] publishable findings exceed hard cap");
  }
}

interface ResolvedPublicationAction {
  readonly finding: PublishedFindingV1;
  readonly findingId: string;
  readonly existingCommentId?: string;
}

export async function publishDeepReviewResult(
  options: PublishDeepReviewOptions,
): Promise<PublishDeepReviewOutcome> {
  const diagnostics: { id: string; message: string }[] = [];
  let result: DeepReviewResultV1;
  let packet: PullRequestPacketV1;
  try {
    ({ result, packet } = await readValidatedPublicationInputs(
      options.resultPath,
      options.packetPath,
    ));
  } catch (error) {
    await completeCheckFailure(options, publicationFailureResult(), error, diagnostics);
    throw error;
  }

  try {
    validatePublicationContext(result, packet, options.owner, options.repo, options.pullNumber);
    return await executePublication(options, result, packet, diagnostics);
  } catch (error) {
    await completeCheckFailure(options, result, error, diagnostics);
    throw error;
  }
}

async function executePublication(
  options: PublishDeepReviewOptions,
  result: DeepReviewResultV1,
  packet: PullRequestPacketV1,
  diagnostics: { id: string; message: string }[],
): Promise<PublishDeepReviewOutcome> {
  const pullRequest = await options.github.getPullRequest(
    options.owner,
    options.repo,
    options.pullNumber,
  );
  if (pullRequest.headSha !== result.headSha) {
    diagnostics.push({
      id: "DEEP_REVIEW_HEAD_CHANGED",
      message: "[DEEP_REVIEW_HEAD_CHANGED] pull request head changed before publication",
    });
    await options.github.updateCheckRun({
      owner: options.owner,
      repo: options.repo,
      checkRunId: options.checkRunId,
      status: "completed",
      conclusion: "failure",
      output: buildCheckOutput(result, options, diagnostics),
    });
    return {
      conclusion: "failure",
      postedCount: 0,
      updatedCount: 0,
      diagnostics,
    };
  }

  const actor = await options.github.getAuthenticatedActor();
  const comments = await options.github.listReviewComments(
    options.owner,
    options.repo,
    options.pullNumber,
  );

  const actions: ResolvedPublicationAction[] = [];
  for (const finding of result.publishableFindings) {
    const resolved = resolveFindingPublication(finding, result, packet, comments, actor.id);
    if ("diagnostic" in resolved) {
      diagnostics.push(resolved.diagnostic);
      if (!SKIPPABLE_PUBLICATION_DIAGNOSTICS.has(resolved.diagnostic.id)) {
        await options.github.updateCheckRun({
          owner: options.owner,
          repo: options.repo,
          checkRunId: options.checkRunId,
          status: "completed",
          conclusion: "failure",
          output: buildCheckOutput(result, options, diagnostics),
        });
        return {
          conclusion: "failure",
          postedCount: 0,
          updatedCount: 0,
          diagnostics,
        };
      }
      continue;
    }
    actions.push(resolved.action);
  }

  let updatedCount = 0;
  for (const action of actions) {
    if (!action.existingCommentId) continue;
    const body = renderFindingCommentBody({
      finding: action.finding,
      repositoryOwner: options.owner,
      repositoryName: options.repo,
      pullRequestNumber: options.pullNumber,
      headSha: result.headSha,
    });
    await options.github.updateReviewComment(
      options.owner,
      options.repo,
      action.existingCommentId,
      body,
    );
    updatedCount += 1;
  }

  const newComments: InlineReviewCommentInput[] = [];
  for (const action of actions) {
    if (action.existingCommentId) continue;
    const mapping = mapToGitHubInlineComment(
      action.finding.file,
      action.finding.side,
      action.finding.line,
      action.finding.endLine,
    );
    const body = renderFindingCommentBody({
      finding: action.finding,
      repositoryOwner: options.owner,
      repositoryName: options.repo,
      pullRequestNumber: options.pullNumber,
      headSha: result.headSha,
    });
    newComments.push({
      path: mapping.path,
      side: mapping.side,
      line: mapping.line,
      body,
      ...(mapping.startLine !== undefined ? { startLine: mapping.startLine } : {}),
      ...(mapping.startSide !== undefined ? { startSide: mapping.startSide } : {}),
    });
  }

  let postedCount = 0;
  if (newComments.length > 0) {
    await options.github.createPullRequestReview({
      owner: options.owner,
      repo: options.repo,
      pullNumber: options.pullNumber,
      commitId: result.headSha,
      event: "COMMENT",
      comments: newComments,
    });
    postedCount = newComments.length;
  }

  const conclusion = result.verdict === "clean" ? "success" : "failure";
  await options.github.updateCheckRun({
    owner: options.owner,
    repo: options.repo,
    checkRunId: options.checkRunId,
    status: "completed",
    conclusion,
    output: buildCheckOutput(result, options, diagnostics),
  });

  return { conclusion, postedCount, updatedCount, diagnostics };
}

function resolveFindingPublication(
  finding: PublishedFindingV1,
  result: DeepReviewResultV1,
  packet: PullRequestPacketV1,
  comments: readonly {
    readonly id: string;
    readonly authorId: string;
    readonly body: string;
  }[],
  actorId: string,
):
  | { readonly action: ResolvedPublicationAction }
  | { readonly diagnostic: { readonly id: string; readonly message: string } } {
  let effectiveFinding = finding;
  const packetFile = findPacketFile(packet.files, finding.file);
  if (!packetFile) {
    return {
      diagnostic: {
        id: "DEEP_REVIEW_LOCATION_INVALID",
        message: `[DEEP_REVIEW_LOCATION_INVALID] finding ${finding.findingId} no longer maps to PR diff`,
      },
    };
  }
  if (!isGitHubPublishableLocation(packetFile, finding.side, finding.line, finding.endLine)) {
    return {
      diagnostic: {
        id: "DEEP_REVIEW_LOCATION_UNPUBLISHABLE",
        message: `[DEEP_REVIEW_LOCATION_UNPUBLISHABLE] finding ${finding.findingId} cannot map to a GitHub inline comment`,
      },
    };
  }

  const stableDedupeKey = finding.stableDedupeKey;
  const recomputedId = computeFindingIdFromFinding(
    result.repository,
    result.pullRequest.number,
    result.headSha,
    finding,
    stableDedupeKey,
  );

  if (recomputedId !== finding.findingId) {
    return {
      diagnostic: {
        id: "DEEP_REVIEW_OUTPUT_INVALID",
        message: `[DEEP_REVIEW_OUTPUT_INVALID] finding ID mismatch for ${finding.findingId}`,
      },
    };
  }

  if (effectiveFinding.matchedPreviousFindingId) {
    const reconciled = reconcilePriorFindingId({
      finding: effectiveFinding,
      stableDedupeKey,
      matchedPreviousFindingId: effectiveFinding.matchedPreviousFindingId,
      previousFindings: packet.previousFindings,
      headSha: result.headSha,
    });
    if (reconciled !== effectiveFinding.matchedPreviousFindingId) {
      const { matchedPreviousFindingId: _removed, ...withoutPriorLink } = effectiveFinding;
      effectiveFinding = withoutPriorLink as PublishedFindingV1;
    }
  }

  const authenticatedMatches = comments.filter((comment) => {
    if (comment.authorId !== actorId) return false;
    const extracted = extractMarkerFromBody(comment.body);
    return (
      extracted.marker?.findingId === effectiveFinding.findingId &&
      extracted.marker.headSha === result.headSha.toLowerCase()
    );
  });

  if (authenticatedMatches.length > 1) {
    return {
      diagnostic: {
        id: "DEEP_REVIEW_MARKER_CONFLICT",
        message: `[DEEP_REVIEW_MARKER_CONFLICT] multiple authenticated comments for ${effectiveFinding.findingId}`,
      },
    };
  }

  return {
    action: {
      finding: effectiveFinding,
      findingId: effectiveFinding.findingId,
      ...(authenticatedMatches[0] ? { existingCommentId: authenticatedMatches[0].id } : {}),
    },
  };
}

function publicationFailureResult(): DeepReviewResultV1 {
  return {
    schemaVersion: "pioneer-deep-review-result/v1",
    runId: "publication-failure",
    repository: { owner: "unknown", name: "unknown" },
    pullRequest: { number: 0 },
    packetDigest: "0".repeat(64),
    baseSha: "0".repeat(40),
    headSha: "0".repeat(40),
    status: "incomplete",
    verdict: "unavailable",
    workers: [],
    president: {
      memberId: "president",
      model: "unknown/unknown",
      status: "failed",
      diagnosticId: "publication-input-failure",
    },
    publishableFindings: [],
    artifactFindings: [],
    diagnostics: [],
  };
}

function buildCheckOutput(
  result: DeepReviewResultV1,
  options: PublishDeepReviewOptions,
  diagnostics: readonly { readonly id: string; readonly message: string }[],
): { readonly title: string; readonly summary: string } {
  const lines = [
    `Status: ${result.status}`,
    `Verdict: ${result.verdict}`,
    `Publishable findings: ${result.publishableFindings.length}`,
  ];
  if (options.workflowRunUrl) {
    lines.push(`Workflow run: ${options.workflowRunUrl}`);
  }
  if (options.artifactUrl) {
    lines.push(`Artifact: ${options.artifactUrl}`);
  }
  for (const diagnostic of diagnostics) {
    lines.push(diagnostic.message);
  }
  return {
    title: DEEP_REVIEW_CHECK_NAME,
    summary: lines.join("\n"),
  };
}

async function completeCheckFailure(
  options: PublishDeepReviewOptions,
  result: DeepReviewResultV1,
  error: unknown,
  diagnostics: { id: string; message: string }[],
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  diagnostics.push({ id: "DEEP_REVIEW_OUTPUT_INVALID", message });
  await options.github.updateCheckRun({
    owner: options.owner,
    repo: options.repo,
    checkRunId: options.checkRunId,
    status: "completed",
    conclusion: "failure",
    output: buildCheckOutput(result, options, diagnostics),
  });
}

export interface StartDeepReviewCheckOptions {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly github: GitHubClient;
}

export interface StartDeepReviewCheckResult {
  readonly checkRunId: string;
  readonly reconciledRunIds: readonly string[];
}

export async function startDeepReviewCheck(
  options: StartDeepReviewCheckOptions,
): Promise<StartDeepReviewCheckResult> {
  const existing = await options.github.listCheckRunsForRef(
    options.owner,
    options.repo,
    options.headSha,
    DEEP_REVIEW_CHECK_NAME,
  );
  const reconciledRunIds: string[] = [];
  for (const run of existing) {
    if (run.status !== "in_progress" && run.status !== "queued") continue;
    await options.github.updateCheckRun({
      owner: options.owner,
      repo: options.repo,
      checkRunId: run.id,
      status: "completed",
      conclusion: "failure",
      output: {
        title: DEEP_REVIEW_CHECK_NAME,
        summary: "Superseded by a newer deep review run.",
      },
    });
    reconciledRunIds.push(run.id);
  }

  const created = await options.github.createCheckRun({
    owner: options.owner,
    repo: options.repo,
    name: DEEP_REVIEW_CHECK_NAME,
    headSha: options.headSha,
    status: "in_progress",
    output: {
      title: DEEP_REVIEW_CHECK_NAME,
      summary: "Deep review in progress.",
    },
  });

  return { checkRunId: created.id, reconciledRunIds };
}
