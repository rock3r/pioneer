import { thinkingFromModelShorthand } from "../pi-model-selection.js";
import type { ThinkingLevel } from "../thinking-level.js";
import { isThinkingLevel } from "../thinking-level.js";
import type { FindingCategoryV1 } from "./finding.js";
import { FINDING_CATEGORIES } from "./finding.js";
import {
  assertNoExtraKeys,
  isRecord,
  optionalField,
  requireArray,
  requireEnum,
  requireNumber,
  requireString,
} from "./validate.js";

export interface CouncilMemberV1 {
  readonly id: string;
  readonly model: string;
  readonly independenceGroup: string;
  readonly thinking?: ThinkingLevel;
}

export interface FocusedCommandPolicyV1 {
  readonly platform: "linux";
  readonly commands: readonly {
    readonly id: string;
    readonly executable: string;
    readonly fixedArgs: readonly string[];
    readonly operandKind: "source-relative-file" | "scratch-relative-file" | "none";
  }[];
  readonly maximumInvocations: number;
  readonly timeoutMsPerInvocation: number;
  readonly maximumOutputBytesPerInvocation: number;
}

export interface DeepReviewConfigV1 {
  readonly schemaVersion: "pioneer-deep-review-config/v1";
  readonly council: readonly CouncilMemberV1[];
  readonly president: CouncilMemberV1;
  readonly consensus?: {
    readonly minimumSupport?: number;
    readonly publishSeverities?: readonly ("critical" | "high" | "medium")[];
    readonly publishCategories?: readonly FindingCategoryV1[];
    readonly requirePresidentConfidence?: "high" | "medium";
  };
  readonly limits?: {
    readonly workerTimeoutMs?: number;
    readonly presidentTimeoutMs?: number;
    readonly maximumParallelWorkers?: number;
    readonly maximumCandidatesPerWorker?: number;
    readonly maximumPublishedFindings?: number;
    readonly maximumPacketBytes?: number;
    readonly maximumModelOutputBytes?: number;
  };
  readonly capabilityProfile?: {
    readonly path: string;
    readonly extensionIds: readonly string[];
  };
  readonly focusedCommands?: FocusedCommandPolicyV1;
}

export const DEFAULT_WORKER_TIMEOUT_MS = 300_000;
export const DEFAULT_PRESIDENT_TIMEOUT_MS = 300_000;
export const HARD_MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_PARALLEL_WORKERS = 8;
export const DEFAULT_MAX_CANDIDATES_PER_WORKER = 20;
export const DEFAULT_MAX_PUBLISHED_FINDINGS = 10;
export const DEFAULT_MAX_MODEL_OUTPUT_BYTES = 256 * 1024;

const MEMBER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const GROUP_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function parseCouncilMember(value: unknown, context: string): CouncilMemberV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context} must be an object`);
  }
  const keys = new Set(["id", "model", "independenceGroup", "thinking"]);
  assertNoExtraKeys(value, keys, context);
  const id = requireString(value.id, "id", context, { maxLength: 64, pattern: MEMBER_ID_PATTERN });
  const model = requireString(value.model, "model", context, {
    maxLength: 256,
    pattern: MODEL_PATTERN,
  });
  const independenceGroup = requireString(value.independenceGroup, "independenceGroup", context, {
    maxLength: 64,
    pattern: GROUP_PATTERN,
  });
  const thinking = optionalField(value, "thinking", (v) => {
    const level = requireString(v, "thinking", context);
    if (!isThinkingLevel(level)) {
      throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context}.thinking is invalid`);
    }
    return level;
  });
  return {
    id,
    model,
    independenceGroup,
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

const CONFIG_KEYS = new Set([
  "schemaVersion",
  "council",
  "president",
  "consensus",
  "limits",
  "capabilityProfile",
  "focusedCommands",
]);

export function parseDeepReviewConfig(value: unknown): DeepReviewConfigV1 {
  const context = "config";
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, CONFIG_KEYS, context);
  const schemaVersion = requireString(value.schemaVersion, "schemaVersion", context);
  if (schemaVersion !== "pioneer-deep-review-config/v1") {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context}.schemaVersion is unsupported`);
  }

  const council = requireArray(value.council, "council", context, (item) =>
    parseCouncilMember(item, `${context}.council[]`),
  );
  const president = parseCouncilMember(value.president, `${context}.president`);

  let consensus: DeepReviewConfigV1["consensus"];
  if (value.consensus !== undefined) {
    if (!isRecord(value.consensus)) {
      throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context}.consensus must be an object`);
    }
    const consensusKeys = new Set([
      "minimumSupport",
      "publishSeverities",
      "publishCategories",
      "requirePresidentConfidence",
    ]);
    assertNoExtraKeys(value.consensus, consensusKeys, `${context}.consensus`);
    const publishSeverities = optionalField(value.consensus, "publishSeverities", (v) =>
      requireArray(v, "publishSeverities", `${context}.consensus`, (item) =>
        requireEnum(
          item,
          "publishSeverities[]",
          `${context}.consensus`,
          new Set(["critical", "high", "medium"] as const),
        ),
      ),
    );
    const publishCategories = optionalField(value.consensus, "publishCategories", (v) =>
      requireArray(v, "publishCategories", `${context}.consensus`, (item) =>
        requireEnum(item, "publishCategories[]", `${context}.consensus`, FINDING_CATEGORIES),
      ),
    );
    const minimumSupport = optionalField(value.consensus, "minimumSupport", (v) =>
      requireNumber(v, "minimumSupport", `${context}.consensus`, { integer: true, min: 1 }),
    );
    const requirePresidentConfidence = optionalField(
      value.consensus,
      "requirePresidentConfidence",
      (v) =>
        requireEnum(
          v,
          "requirePresidentConfidence",
          `${context}.consensus`,
          new Set(["high", "medium"] as const),
        ),
    );
    consensus = {
      ...(minimumSupport !== undefined ? { minimumSupport } : {}),
      ...(publishSeverities !== undefined ? { publishSeverities } : {}),
      ...(publishCategories !== undefined ? { publishCategories } : {}),
      ...(requirePresidentConfidence !== undefined ? { requirePresidentConfidence } : {}),
    };
  }

  let limits: DeepReviewConfigV1["limits"];
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) {
      throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context}.limits must be an object`);
    }
    const limitsKeys = new Set([
      "workerTimeoutMs",
      "presidentTimeoutMs",
      "maximumParallelWorkers",
      "maximumCandidatesPerWorker",
      "maximumPublishedFindings",
      "maximumPacketBytes",
      "maximumModelOutputBytes",
    ]);
    assertNoExtraKeys(value.limits, limitsKeys, `${context}.limits`);
    limits = {
      ...(optionalField(value.limits, "workerTimeoutMs", (v) =>
        requireNumber(v, "workerTimeoutMs", `${context}.limits`, {
          integer: true,
          min: 1,
          max: HARD_MAX_TIMEOUT_MS,
        }),
      ) !== undefined
        ? {
            workerTimeoutMs: requireNumber(
              value.limits.workerTimeoutMs,
              "workerTimeoutMs",
              `${context}.limits`,
              {
                integer: true,
                min: 1,
                max: HARD_MAX_TIMEOUT_MS,
              },
            ),
          }
        : {}),
      ...(optionalField(value.limits, "presidentTimeoutMs", (v) =>
        requireNumber(v, "presidentTimeoutMs", `${context}.limits`, {
          integer: true,
          min: 1,
          max: HARD_MAX_TIMEOUT_MS,
        }),
      ) !== undefined
        ? {
            presidentTimeoutMs: requireNumber(
              value.limits.presidentTimeoutMs,
              "presidentTimeoutMs",
              `${context}.limits`,
              {
                integer: true,
                min: 1,
                max: HARD_MAX_TIMEOUT_MS,
              },
            ),
          }
        : {}),
      ...(optionalField(value.limits, "maximumParallelWorkers", (v) =>
        requireNumber(v, "maximumParallelWorkers", `${context}.limits`, {
          integer: true,
          min: 1,
          max: DEFAULT_MAX_PARALLEL_WORKERS,
        }),
      ) !== undefined
        ? {
            maximumParallelWorkers: requireNumber(
              value.limits.maximumParallelWorkers,
              "maximumParallelWorkers",
              `${context}.limits`,
              {
                integer: true,
                min: 1,
                max: DEFAULT_MAX_PARALLEL_WORKERS,
              },
            ),
          }
        : {}),
      ...(optionalField(value.limits, "maximumCandidatesPerWorker", (v) =>
        requireNumber(v, "maximumCandidatesPerWorker", `${context}.limits`, {
          integer: true,
          min: 1,
        }),
      ) !== undefined
        ? {
            maximumCandidatesPerWorker: requireNumber(
              value.limits.maximumCandidatesPerWorker,
              "maximumCandidatesPerWorker",
              `${context}.limits`,
              { integer: true, min: 1 },
            ),
          }
        : {}),
      ...(optionalField(value.limits, "maximumPublishedFindings", (v) =>
        requireNumber(v, "maximumPublishedFindings", `${context}.limits`, {
          integer: true,
          min: 1,
        }),
      ) !== undefined
        ? {
            maximumPublishedFindings: requireNumber(
              value.limits.maximumPublishedFindings,
              "maximumPublishedFindings",
              `${context}.limits`,
              { integer: true, min: 1 },
            ),
          }
        : {}),
      ...(optionalField(value.limits, "maximumPacketBytes", (v) =>
        requireNumber(v, "maximumPacketBytes", `${context}.limits`, { integer: true, min: 1 }),
      ) !== undefined
        ? {
            maximumPacketBytes: requireNumber(
              value.limits.maximumPacketBytes,
              "maximumPacketBytes",
              `${context}.limits`,
              {
                integer: true,
                min: 1,
              },
            ),
          }
        : {}),
      ...(optionalField(value.limits, "maximumModelOutputBytes", (v) =>
        requireNumber(v, "maximumModelOutputBytes", `${context}.limits`, { integer: true, min: 1 }),
      ) !== undefined
        ? {
            maximumModelOutputBytes: requireNumber(
              value.limits.maximumModelOutputBytes,
              "maximumModelOutputBytes",
              `${context}.limits`,
              { integer: true, min: 1 },
            ),
          }
        : {}),
    };
  }

  let capabilityProfile: DeepReviewConfigV1["capabilityProfile"];
  if (value.capabilityProfile !== undefined) {
    if (!isRecord(value.capabilityProfile)) {
      throw new Error(
        `[DEEP_REVIEW_CONFIG_INVALID] ${context}.capabilityProfile must be an object`,
      );
    }
    const profileKeys = new Set(["path", "extensionIds"]);
    assertNoExtraKeys(value.capabilityProfile, profileKeys, `${context}.capabilityProfile`);
    capabilityProfile = {
      path: requireString(value.capabilityProfile.path, "path", `${context}.capabilityProfile`, {
        maxLength: 4096,
      }),
      extensionIds: requireArray(
        value.capabilityProfile.extensionIds,
        "extensionIds",
        `${context}.capabilityProfile`,
        (item) =>
          requireString(item, "extensionIds[]", `${context}.capabilityProfile`, { maxLength: 128 }),
      ),
    };
  }

  let focusedCommands: FocusedCommandPolicyV1 | undefined;
  if (value.focusedCommands !== undefined) {
    if (!isRecord(value.focusedCommands)) {
      throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context}.focusedCommands must be an object`);
    }
    const fcKeys = new Set([
      "platform",
      "commands",
      "maximumInvocations",
      "timeoutMsPerInvocation",
      "maximumOutputBytesPerInvocation",
    ]);
    assertNoExtraKeys(value.focusedCommands, fcKeys, `${context}.focusedCommands`);
    focusedCommands = {
      platform: requireEnum(
        value.focusedCommands.platform,
        "platform",
        `${context}.focusedCommands`,
        new Set(["linux"] as const),
      ),
      commands: requireArray(
        value.focusedCommands.commands,
        "commands",
        `${context}.focusedCommands`,
        (item) => {
          if (!isRecord(item)) {
            throw new Error(
              `[DEEP_REVIEW_CONFIG_INVALID] ${context}.focusedCommands.commands[] must be an object`,
            );
          }
          const cmdKeys = new Set(["id", "executable", "fixedArgs", "operandKind"]);
          assertNoExtraKeys(item, cmdKeys, `${context}.focusedCommands.commands[]`);
          return {
            id: requireString(item.id, "id", `${context}.focusedCommands.commands[]`, {
              maxLength: 64,
            }),
            executable: requireString(
              item.executable,
              "executable",
              `${context}.focusedCommands.commands[]`,
              {
                maxLength: 4096,
              },
            ),
            fixedArgs: requireArray(
              item.fixedArgs,
              "fixedArgs",
              `${context}.focusedCommands.commands[]`,
              (arg) =>
                requireString(arg, "fixedArgs[]", `${context}.focusedCommands.commands[]`, {
                  maxLength: 4096,
                }),
            ),
            operandKind: requireEnum(
              item.operandKind,
              "operandKind",
              `${context}.focusedCommands.commands[]`,
              new Set(["source-relative-file", "scratch-relative-file", "none"] as const),
            ),
          };
        },
      ),
      maximumInvocations: requireNumber(
        value.focusedCommands.maximumInvocations,
        "maximumInvocations",
        `${context}.focusedCommands`,
        { integer: true, min: 0 },
      ),
      timeoutMsPerInvocation: requireNumber(
        value.focusedCommands.timeoutMsPerInvocation,
        "timeoutMsPerInvocation",
        `${context}.focusedCommands`,
        { integer: true, min: 1 },
      ),
      maximumOutputBytesPerInvocation: requireNumber(
        value.focusedCommands.maximumOutputBytesPerInvocation,
        "maximumOutputBytesPerInvocation",
        `${context}.focusedCommands`,
        { integer: true, min: 1 },
      ),
    };
  }

  const config: DeepReviewConfigV1 = {
    schemaVersion: "pioneer-deep-review-config/v1",
    council,
    president,
    ...(consensus !== undefined ? { consensus } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    ...(focusedCommands !== undefined ? { focusedCommands } : {}),
  };

  validateCouncilIndependence(config);
  return config;
}

function canonicalCouncilModelIdentity(model: string): string {
  const trimmed = model.trim();
  const thinking = thinkingFromModelShorthand(trimmed);
  const withoutThinking =
    thinking === undefined ? trimmed : trimmed.slice(0, trimmed.lastIndexOf(":"));
  return withoutThinking.toLowerCase();
}

export function validateCouncilIndependence(config: DeepReviewConfigV1): void {
  const memberIds = new Set<string>();
  const models = new Set<string>();
  const groups = new Set<string>();

  for (const member of [...config.council, config.president]) {
    if (memberIds.has(member.id)) {
      throw new Error(`[DEEP_REVIEW_INDEPENDENCE_INVALID] duplicate member id: ${member.id}`);
    }
    memberIds.add(member.id);
  }

  for (const member of config.council) {
    const modelIdentity = canonicalCouncilModelIdentity(member.model);
    if (models.has(modelIdentity)) {
      throw new Error(
        `[DEEP_REVIEW_INDEPENDENCE_INVALID] duplicate council model: ${member.model}`,
      );
    }
    models.add(modelIdentity);
    if (groups.has(member.independenceGroup)) {
      throw new Error(
        `[DEEP_REVIEW_INDEPENDENCE_INVALID] duplicate independence group: ${member.independenceGroup}`,
      );
    }
    groups.add(member.independenceGroup);
  }

  const uniqueGroups = new Set(config.council.map((m) => m.independenceGroup));
  if (uniqueGroups.size < 2) {
    throw new Error(
      `[DEEP_REVIEW_INDEPENDENCE_INVALID] council requires at least two independence groups`,
    );
  }

  const effectiveThreshold = computeMinimumSupport(config);
  const configuredMinimum = config.consensus?.minimumSupport;
  if (configuredMinimum !== undefined) {
    const strictMajority = computeStrictMajorityThreshold(uniqueGroups.size);
    if (configuredMinimum < strictMajority || configuredMinimum < 2) {
      throw new Error(
        `[DEEP_REVIEW_CONFIG_INVALID] minimumSupport cannot be below strict majority floor`,
      );
    }
    if (configuredMinimum > uniqueGroups.size) {
      throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] minimumSupport exceeds configured group count`);
    }
  }
  if (effectiveThreshold > uniqueGroups.size) {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] impossible support threshold`);
  }
}

export function computeStrictMajorityThreshold(configuredGroupCount: number): number {
  return Math.max(2, Math.floor(configuredGroupCount / 2) + 1);
}

export function computeMinimumSupport(config: DeepReviewConfigV1): number {
  const groupCount = new Set(config.council.map((m) => m.independenceGroup)).size;
  const strictMajority = computeStrictMajorityThreshold(groupCount);
  const configured = config.consensus?.minimumSupport;
  if (configured === undefined) return strictMajority;
  return Math.max(configured, strictMajority, 2);
}

export function resolvedConfigLimits(
  config: DeepReviewConfigV1,
): Required<NonNullable<DeepReviewConfigV1["limits"]>> {
  return {
    workerTimeoutMs: config.limits?.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
    presidentTimeoutMs: config.limits?.presidentTimeoutMs ?? DEFAULT_PRESIDENT_TIMEOUT_MS,
    maximumParallelWorkers: config.limits?.maximumParallelWorkers ?? DEFAULT_MAX_PARALLEL_WORKERS,
    maximumCandidatesPerWorker:
      config.limits?.maximumCandidatesPerWorker ?? DEFAULT_MAX_CANDIDATES_PER_WORKER,
    maximumPublishedFindings:
      config.limits?.maximumPublishedFindings ?? DEFAULT_MAX_PUBLISHED_FINDINGS,
    maximumPacketBytes: config.limits?.maximumPacketBytes ?? 2 * 1024 * 1024,
    maximumModelOutputBytes:
      config.limits?.maximumModelOutputBytes ?? DEFAULT_MAX_MODEL_OUTPUT_BYTES,
  };
}

export function resolvedPublishPolicy(config: DeepReviewConfigV1): {
  readonly publishSeverities: ReadonlySet<"critical" | "high" | "medium">;
  readonly publishCategories: ReadonlySet<FindingCategoryV1>;
  readonly requirePresidentConfidence: "high" | "medium";
} {
  return {
    publishSeverities: new Set(
      config.consensus?.publishSeverities ?? (["critical", "high", "medium"] as const),
    ),
    publishCategories: new Set(
      config.consensus?.publishCategories ??
        (["correctness", "security", "architecture", "performance"] as const),
    ),
    requirePresidentConfidence: config.consensus?.requirePresidentConfidence ?? "high",
  };
}
