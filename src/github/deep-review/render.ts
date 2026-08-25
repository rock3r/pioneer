import type { PublishedFindingV1 } from "../../deep-review/consensus.js";
import { buildMarkerPayload, formatMarkerComment } from "./marker.js";

const MAX_RENDERED_BODY_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 4_096;

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const USER_MENTION_PATTERN = /(^|[^\w`])@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)/gi;
const TEAM_MENTION_PATTERN = /(^|[^\w`])@([a-z0-9-]+\/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)/gi;

export function stripModelHtmlComments(text: string): string {
  return text.replaceAll(HTML_COMMENT_PATTERN, "").trim();
}

export function neutralizeMentions(text: string): string {
  let sanitized = text.replaceAll(TEAM_MENTION_PATTERN, (_match, prefix: string, slug: string) => {
    return `${prefix}@\u200b${slug}`;
  });
  sanitized = sanitized.replaceAll(
    USER_MENTION_PATTERN,
    (_match, prefix: string, login: string) => {
      if (login.includes("/")) return `${prefix}@${login}`;
      return `${prefix}@\u200b${login}`;
    },
  );
  return sanitized;
}

export function sanitizeFindingField(text: string): string {
  const stripped = stripModelHtmlComments(text);
  const neutralized = neutralizeMentions(stripped);
  return neutralized.slice(0, MAX_FIELD_LENGTH);
}

export interface RenderFindingCommentInput {
  readonly finding: PublishedFindingV1;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
}

export function renderFindingCommentBody(input: RenderFindingCommentInput): string {
  const { finding } = input;
  const title = sanitizeFindingField(finding.title);
  const summary = sanitizeFindingField(finding.summary);
  const evidence = sanitizeFindingField(finding.evidence);
  const whyItMatters = sanitizeFindingField(finding.whyItMatters);
  const suggestedFix = sanitizeFindingField(finding.suggestedFix);

  const sections = [
    `### ${title}`,
    "",
    `**Severity:** ${finding.severity} · **Category:** ${finding.category} · **Confidence:** ${finding.presidentConfidence}`,
    "",
    summary,
    "",
    "**Evidence**",
    "",
    evidence,
    "",
    "**Why it matters**",
    "",
    whyItMatters,
    "",
    "**Suggested fix**",
    "",
    suggestedFix,
  ];

  const marker = formatMarkerComment(
    buildMarkerPayload({
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      pullRequestNumber: input.pullRequestNumber,
      findingId: finding.findingId,
      headSha: input.headSha,
      path: finding.file,
      side: finding.side,
      line: finding.line,
      endLine: finding.endLine,
      category: finding.category,
    }),
  );

  let body = `${sections.join("\n")}\n\n${marker}`;
  while (Buffer.byteLength(body, "utf8") > MAX_RENDERED_BODY_BYTES) {
    const overflow = Buffer.byteLength(body, "utf8") - MAX_RENDERED_BODY_BYTES;
    body = `${body.slice(0, Math.max(0, body.length - overflow - marker.length - 2))}\n\n${marker}`;
  }
  return body;
}
