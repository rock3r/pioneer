import { createHash } from "node:crypto";
import type { DiffSideV1, FindingCategoryV1 } from "./finding.js";
import { DIFF_SIDES, FINDING_CATEGORIES } from "./finding.js";
import {
  assertNoExtraKeys,
  isRecord,
  optionalField,
  requireArray,
  requireEnum,
  requireGitSha,
  requireNumber,
  requireRepoRelativePath,
  requireString,
} from "./validate.js";

export interface PullRequestFileV1 {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied";
  readonly contentKind: "text" | "binary";
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
  readonly patchOmittedReason?: "binary";
}

export interface PreviousFindingMarkerV1 {
  readonly findingId: string;
  readonly headSha: string;
  readonly path: string;
  readonly side: DiffSideV1;
  readonly line: number;
  readonly endLine: number;
  readonly category: FindingCategoryV1;
}

export interface PreviousFindingV1 {
  readonly commentId: string;
  readonly authorId: string;
  readonly authorLogin: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly side?: DiffSideV1;
  readonly marker?: PreviousFindingMarkerV1;
  readonly replies: readonly {
    readonly commentId: string;
    readonly authorId: string;
    readonly authorLogin: string;
    readonly body: string;
  }[];
}

export interface PullRequestPacketV1 {
  readonly schemaVersion: "pioneer-pr-review-packet/v1";
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly repositoryId?: string;
  };
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly body: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly commits: readonly {
    readonly sha: string;
    readonly title: string;
    readonly body: string;
  }[];
  readonly files: readonly PullRequestFileV1[];
  readonly rules: readonly {
    readonly path: string;
    readonly content: string;
    readonly source: "base" | "head" | "workflow";
  }[];
  readonly previousFindings: readonly PreviousFindingV1[];
  readonly packetDigest: string;
}

const FILE_STATUSES = new Set(["added", "modified", "deleted", "renamed", "copied"] as const);
const CONTENT_KINDS = new Set(["text", "binary"] as const);
const RULE_SOURCES = new Set(["base", "head", "workflow"] as const);

const MAX_PACKET_TEXT = 64 * 1024;
export const DEFAULT_MAXIMUM_PACKET_BYTES = 2 * 1024 * 1024;
export const HARD_MAXIMUM_PACKET_BYTES = 8 * 1024 * 1024;

function parsePreviousFindingMarker(value: unknown, context: string): PreviousFindingMarkerV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context} must be an object`);
  }
  const keys = new Set(["findingId", "headSha", "path", "side", "line", "endLine", "category"]);
  assertNoExtraKeys(value, keys, context);
  return {
    findingId: requireString(value.findingId, "findingId", context, { maxLength: 128 }),
    headSha: requireGitSha(value.headSha, "headSha", context),
    path: requireRepoRelativePath(value.path, "path", context),
    side: requireEnum(value.side, "side", context, DIFF_SIDES),
    line: requireNumber(value.line, "line", context, { integer: true, min: 1 }),
    endLine: requireNumber(value.endLine, "endLine", context, { integer: true, min: 1 }),
    category: requireEnum(value.category, "category", context, FINDING_CATEGORIES),
  };
}

function parsePreviousFinding(value: unknown, context: string): PreviousFindingV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context} must be an object`);
  }
  const keys = new Set([
    "commentId",
    "authorId",
    "authorLogin",
    "body",
    "path",
    "line",
    "side",
    "marker",
    "replies",
  ]);
  assertNoExtraKeys(value, keys, context);
  const path = optionalField(value, "path", (v) => requireRepoRelativePath(v, "path", context));
  const line = optionalField(value, "line", (v) =>
    requireNumber(v, "line", context, { integer: true, min: 1 }),
  );
  const side = optionalField(value, "side", (v) => requireEnum(v, "side", context, DIFF_SIDES));
  const marker = optionalField(value, "marker", (v) =>
    parsePreviousFindingMarker(v, `${context}.marker`),
  );
  return {
    commentId: requireString(value.commentId, "commentId", context, { maxLength: 64 }),
    authorId: requireString(value.authorId, "authorId", context, { maxLength: 64 }),
    authorLogin: requireString(value.authorLogin, "authorLogin", context, { maxLength: 128 }),
    body: requireString(value.body, "body", context, { maxLength: MAX_PACKET_TEXT }),
    ...(path !== undefined ? { path } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(side !== undefined ? { side } : {}),
    ...(marker !== undefined ? { marker } : {}),
    replies: requireArray(value.replies, "replies", context, (item) => {
      if (!isRecord(item)) {
        throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context}.replies[] must be an object`);
      }
      const replyKeys = new Set(["commentId", "authorId", "authorLogin", "body"]);
      assertNoExtraKeys(item, replyKeys, `${context}.replies[]`);
      return {
        commentId: requireString(item.commentId, "commentId", context, { maxLength: 64 }),
        authorId: requireString(item.authorId, "authorId", context, { maxLength: 64 }),
        authorLogin: requireString(item.authorLogin, "authorLogin", context, { maxLength: 128 }),
        body: requireString(item.body, "body", context, { maxLength: MAX_PACKET_TEXT }),
      };
    }),
  };
}

function parsePullRequestFile(value: unknown, context: string): PullRequestFileV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context} must be an object`);
  }
  const keys = new Set([
    "path",
    "previousPath",
    "status",
    "contentKind",
    "additions",
    "deletions",
    "patch",
    "patchOmittedReason",
  ]);
  assertNoExtraKeys(value, keys, context);
  const contentKind = requireEnum(value.contentKind, "contentKind", context, CONTENT_KINDS);
  const patch = optionalField(value, "patch", (v) => requireString(v, "patch", context));
  const patchOmittedReason = optionalField(value, "patchOmittedReason", (v) =>
    requireEnum(v, "patchOmittedReason", context, new Set(["binary"] as const)),
  );
  const previousPath = optionalField(value, "previousPath", (v) =>
    requireRepoRelativePath(v, "previousPath", context),
  );

  if (contentKind === "binary") {
    if (patch) {
      throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context} binary file must not include patch`);
    }
    if (patchOmittedReason !== "binary") {
      throw new Error(
        `[DEEP_REVIEW_PACKET_INVALID] ${context} binary file requires patchOmittedReason`,
      );
    }
  } else if (patchOmittedReason) {
    throw new Error(
      `[DEEP_REVIEW_PACKET_INVALID] ${context} text file must not omit patch without reason`,
    );
  }

  return {
    path: requireRepoRelativePath(value.path, "path", context),
    ...(previousPath !== undefined ? { previousPath } : {}),
    status: requireEnum(value.status, "status", context, FILE_STATUSES),
    contentKind,
    additions: requireNumber(value.additions, "additions", context, { integer: true, min: 0 }),
    deletions: requireNumber(value.deletions, "deletions", context, { integer: true, min: 0 }),
    ...(patch !== undefined ? { patch } : {}),
    ...(patchOmittedReason !== undefined ? { patchOmittedReason } : {}),
  };
}

const PACKET_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "commits",
  "files",
  "rules",
  "previousFindings",
  "packetDigest",
]);

export function parsePullRequestPacket(value: unknown): PullRequestPacketV1 {
  const context = "packet";
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, PACKET_KEYS, context);
  const schemaVersion = requireString(value.schemaVersion, "schemaVersion", context);
  if (schemaVersion !== "pioneer-pr-review-packet/v1") {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context}.schemaVersion is unsupported`);
  }

  if (!isRecord(value.repository)) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context}.repository must be an object`);
  }
  const repositoryKeys = new Set(["owner", "name", "repositoryId"]);
  assertNoExtraKeys(value.repository, repositoryKeys, `${context}.repository`);
  const repositoryId = optionalField(value.repository, "repositoryId", (v) =>
    requireString(v, "repositoryId", context, { maxLength: 64 }),
  );

  if (!isRecord(value.pullRequest)) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context}.pullRequest must be an object`);
  }
  const prKeys = new Set(["number", "url", "title", "body", "baseRef", "baseSha", "headSha"]);
  assertNoExtraKeys(value.pullRequest, prKeys, `${context}.pullRequest`);

  const packet: PullRequestPacketV1 = {
    schemaVersion: "pioneer-pr-review-packet/v1",
    repository: {
      owner: requireString(value.repository.owner, "owner", `${context}.repository`, {
        maxLength: 128,
      }),
      name: requireString(value.repository.name, "name", `${context}.repository`, {
        maxLength: 128,
      }),
      ...(repositoryId !== undefined ? { repositoryId } : {}),
    },
    pullRequest: {
      number: requireNumber(value.pullRequest.number, "number", `${context}.pullRequest`, {
        integer: true,
        min: 1,
      }),
      url: requireString(value.pullRequest.url, "url", `${context}.pullRequest`, {
        maxLength: 512,
      }),
      title: requireString(value.pullRequest.title, "title", `${context}.pullRequest`, {
        maxLength: MAX_PACKET_TEXT,
      }),
      body: requireString(value.pullRequest.body, "body", `${context}.pullRequest`, {
        maxLength: MAX_PACKET_TEXT,
      }),
      baseRef: requireString(value.pullRequest.baseRef, "baseRef", `${context}.pullRequest`, {
        maxLength: 256,
      }),
      baseSha: requireGitSha(value.pullRequest.baseSha, "baseSha", `${context}.pullRequest`),
      headSha: requireGitSha(value.pullRequest.headSha, "headSha", `${context}.pullRequest`),
    },
    commits: requireArray(value.commits, "commits", context, (item) => {
      if (!isRecord(item)) {
        throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context}.commits[] must be an object`);
      }
      const commitKeys = new Set(["sha", "title", "body"]);
      assertNoExtraKeys(item, commitKeys, `${context}.commits[]`);
      return {
        sha: requireGitSha(item.sha, "sha", `${context}.commits[]`),
        title: requireString(item.title, "title", `${context}.commits[]`, {
          maxLength: MAX_PACKET_TEXT,
        }),
        body: requireString(item.body, "body", `${context}.commits[]`, {
          maxLength: MAX_PACKET_TEXT,
        }),
      };
    }),
    files: requireArray(value.files, "files", context, (item) =>
      parsePullRequestFile(item, `${context}.files[]`),
    ),
    rules: requireArray(value.rules, "rules", context, (item) => {
      if (!isRecord(item)) {
        throw new Error(`[DEEP_REVIEW_PACKET_INVALID] ${context}.rules[] must be an object`);
      }
      const ruleKeys = new Set(["path", "content", "source"]);
      assertNoExtraKeys(item, ruleKeys, `${context}.rules[]`);
      return {
        path: requireRepoRelativePath(item.path, "path", `${context}.rules[]`),
        content: requireString(item.content, "content", `${context}.rules[]`, {
          maxLength: MAX_PACKET_TEXT,
        }),
        source: requireEnum(item.source, "source", `${context}.rules[]`, RULE_SOURCES),
      };
    }),
    previousFindings: requireArray(value.previousFindings, "previousFindings", context, (item) =>
      parsePreviousFinding(item, `${context}.previousFindings[]`),
    ),
    packetDigest: requireString(value.packetDigest, "packetDigest", context, { maxLength: 128 }),
  };

  const { packetDigest: _ignored, ...digestInput } = packet;
  const computed = computePacketDigest(digestInput);
  if (computed !== packet.packetDigest) {
    throw new Error(`[DEEP_REVIEW_PACKET_INVALID] packetDigest mismatch`);
  }

  return packet;
}

export function computePacketDigest(packet: Omit<PullRequestPacketV1, "packetDigest">): string {
  const canonical = canonicalizeForDigest(packet);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return hash;
}

function canonicalizeForDigest(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeForDigest(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeForDigest(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function validatePacketCompleteness(
  packet: PullRequestPacketV1,
  maxBytes: number = DEFAULT_MAXIMUM_PACKET_BYTES,
): void {
  const serialized = JSON.stringify(packet);
  if (serialized.length > maxBytes) {
    throw new Error(`[DEEP_REVIEW_PACKET_INCOMPLETE] packet exceeds size limit`);
  }
  const hasReviewableText = packet.files.some(
    (file) => file.contentKind === "text" && file.patch !== undefined && file.patch.length > 0,
  );
  if (!hasReviewableText) {
    throw new Error(`[DEEP_REVIEW_PACKET_INCOMPLETE] packet has no reviewable text hunks`);
  }
  for (const file of packet.files) {
    if (file.contentKind === "text" && file.patch === undefined && !file.patchOmittedReason) {
      throw new Error(`[DEEP_REVIEW_PACKET_INCOMPLETE] text file missing patch: ${file.path}`);
    }
  }
}
