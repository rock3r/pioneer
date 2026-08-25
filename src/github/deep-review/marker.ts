import type { DiffSideV1, FindingCategoryV1 } from "../../deep-review/finding.js";
import { DIFF_SIDES, FINDING_CATEGORIES } from "../../deep-review/finding.js";
import { requireGitSha } from "../../deep-review/validate.js";

export const MARKER_SCHEMA_VERSION = "pioneer-deep-review-marker/v1" as const;
export const MARKER_PREFIX = "<!-- pioneer-deep-review:";
export const MARKER_SUFFIX = " -->";

export interface MarkerPayloadV1 {
  readonly schemaVersion: typeof MARKER_SCHEMA_VERSION;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly findingId: string;
  readonly headSha: string;
  readonly path: string;
  readonly side: DiffSideV1;
  readonly line: number;
  readonly endLine: number;
  readonly category: FindingCategoryV1;
}

const MARKER_COMMENT_PATTERN = /<!--\s*pioneer-deep-review:([A-Za-z0-9_-]+)\s*-->\s*$/;

function canonicalizeMarkerPayload(payload: Omit<MarkerPayloadV1, "schemaVersion">): string {
  const record: Record<string, unknown> = {
    category: payload.category,
    endLine: payload.endLine,
    findingId: payload.findingId,
    headSha: payload.headSha,
    line: payload.line,
    path: payload.path,
    pullRequestNumber: payload.pullRequestNumber,
    repositoryName: payload.repositoryName,
    repositoryOwner: payload.repositoryOwner,
    schemaVersion: MARKER_SCHEMA_VERSION,
    side: payload.side,
  };
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function encodeMarkerPayload(payload: MarkerPayloadV1): string {
  if (payload.schemaVersion !== MARKER_SCHEMA_VERSION) {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] unsupported marker schema version");
  }
  const canonical = canonicalizeMarkerPayload(payload);
  return Buffer.from(canonical, "utf8").toString("base64url");
}

export function decodeMarkerPayload(encoded: string): MarkerPayloadV1 | undefined {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value);
    const allowed = new Set([
      "schemaVersion",
      "repositoryOwner",
      "repositoryName",
      "pullRequestNumber",
      "findingId",
      "headSha",
      "path",
      "side",
      "line",
      "endLine",
      "category",
    ]);
    if (keys.some((key) => !allowed.has(key)) || keys.length !== allowed.size) {
      return undefined;
    }
    if (value.schemaVersion !== MARKER_SCHEMA_VERSION) return undefined;
    if (typeof value.repositoryOwner !== "string" || value.repositoryOwner.length === 0) {
      return undefined;
    }
    if (typeof value.repositoryName !== "string" || value.repositoryName.length === 0) {
      return undefined;
    }
    if (typeof value.pullRequestNumber !== "number" || !Number.isInteger(value.pullRequestNumber)) {
      return undefined;
    }
    if (typeof value.findingId !== "string" || value.findingId.length === 0) return undefined;
    if (typeof value.path !== "string" || value.path.length === 0) return undefined;
    if (typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 1) {
      return undefined;
    }
    if (
      typeof value.endLine !== "number" ||
      !Number.isInteger(value.endLine) ||
      value.endLine < 1
    ) {
      return undefined;
    }
    if (value.endLine < value.line) return undefined;
    if (typeof value.side !== "string" || !DIFF_SIDES.has(value.side as DiffSideV1)) {
      return undefined;
    }
    if (
      typeof value.category !== "string" ||
      !FINDING_CATEGORIES.has(value.category as FindingCategoryV1)
    ) {
      return undefined;
    }
    try {
      requireGitSha(String(value.headSha), "headSha", "marker");
    } catch {
      return undefined;
    }
    const payload: MarkerPayloadV1 = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      repositoryOwner: value.repositoryOwner,
      repositoryName: value.repositoryName,
      pullRequestNumber: value.pullRequestNumber,
      findingId: value.findingId,
      headSha: String(value.headSha).toLowerCase(),
      path: value.path,
      side: value.side as DiffSideV1,
      line: value.line,
      endLine: value.endLine,
      category: value.category as FindingCategoryV1,
    };
    const canonical = canonicalizeMarkerPayload(payload);
    const roundTrip = Buffer.from(canonical, "utf8").toString("base64url");
    if (roundTrip !== encoded) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function formatMarkerComment(payload: MarkerPayloadV1): string {
  return `${MARKER_PREFIX}${encodeMarkerPayload(payload)}${MARKER_SUFFIX}`;
}

export interface ExtractedMarker {
  readonly visibleBody: string;
  readonly marker?: MarkerPayloadV1;
}

export function extractMarkerFromBody(body: string): ExtractedMarker {
  const match = MARKER_COMMENT_PATTERN.exec(body);
  if (!match) {
    return { visibleBody: body };
  }
  const encoded = match[1];
  if (!encoded) {
    return { visibleBody: body };
  }
  const marker = decodeMarkerPayload(encoded);
  const visibleBody = body.slice(0, match.index).trimEnd();
  return marker ? { visibleBody, marker } : { visibleBody: body };
}

export function buildMarkerPayload(input: {
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly findingId: string;
  readonly headSha: string;
  readonly path: string;
  readonly side: DiffSideV1;
  readonly line: number;
  readonly endLine: number;
  readonly category: FindingCategoryV1;
}): MarkerPayloadV1 {
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    pullRequestNumber: input.pullRequestNumber,
    findingId: input.findingId,
    headSha: input.headSha.toLowerCase(),
    path: input.path,
    side: input.side,
    line: input.line,
    endLine: input.endLine,
    category: input.category,
  };
}
