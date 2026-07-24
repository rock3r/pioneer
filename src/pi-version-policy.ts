import { readFileSync } from "node:fs";
import { diagnosticMessage } from "./diagnostics.js";

interface PiCompatibilityPolicy {
  readonly package?: unknown;
  readonly minimum?: unknown;
  readonly testedMaximum?: unknown;
  readonly requiredCliOptions?: unknown;
  readonly requiredThinkingLevels?: unknown;
}

interface SemanticVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

export interface PiVersionValidation {
  readonly version: string;
  readonly error?: string;
  readonly warning?: string;
}

const policy = JSON.parse(
  readFileSync(new URL("../pi-compatibility.json", import.meta.url), "utf8"),
) as PiCompatibilityPolicy;

if (
  policy.package !== "@earendil-works/pi-coding-agent" ||
  typeof policy.minimum !== "string" ||
  typeof policy.testedMaximum !== "string" ||
  !Array.isArray(policy.requiredCliOptions) ||
  !Array.isArray(policy.requiredThinkingLevels) ||
  !policy.requiredCliOptions.every((value) => typeof value === "string") ||
  !policy.requiredThinkingLevels.every((value) => typeof value === "string")
) {
  throw new Error("Pi compatibility policy is invalid");
}

export const PI_MINIMUM_VERSION = policy.minimum;
export const PI_TESTED_MAXIMUM_VERSION = policy.testedMaximum;
export const PI_REQUIRED_CLI_OPTIONS = policy.requiredCliOptions as readonly string[];
export const PI_REQUIRED_THINKING_LEVELS = policy.requiredThinkingLevels as readonly string[];

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return {
    core: [major, minor, patch],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requiredSemanticVersion(value: string): SemanticVersion {
  const parsed = parseSemanticVersion(value);
  if (parsed === undefined) {
    throw new Error("Pi compatibility policy versions must be semantic versions");
  }
  return parsed;
}

const parsedMinimum = requiredSemanticVersion(PI_MINIMUM_VERSION);
const parsedMaximum = requiredSemanticVersion(PI_TESTED_MAXIMUM_VERSION);
if (compareVersions(parsedMinimum, parsedMaximum) > 0) {
  throw new Error("Pi compatibility policy minimum exceeds its tested maximum");
}

export function validatePiVersion(version: string): PiVersionValidation {
  const parsed = parseSemanticVersion(version);
  if (parsed === undefined) {
    return {
      version,
      error: diagnosticMessage(
        "PI_VERSION_UNRECOGNIZED",
        `Pi returned an unrecognized version: ${version}. Install a released Pi version between ${PI_MINIMUM_VERSION} and ${PI_TESTED_MAXIMUM_VERSION}, or newer with a compatibility warning.`,
      ),
    };
  }
  if (compareVersions(parsed, parsedMinimum) < 0) {
    return {
      version,
      error: diagnosticMessage(
        "PI_VERSION_TOO_OLD",
        `Pi ${version} is unsupported. Pioneer requires Pi ${PI_MINIMUM_VERSION} or newer. Update Pi and retry.`,
      ),
    };
  }
  if (compareVersions(parsed, parsedMaximum) > 0) {
    return {
      version,
      warning: diagnosticMessage(
        "PI_VERSION_UNTESTED",
        `Pi ${version} is newer than the newest version tested with this Pioneer release (${PI_TESTED_MAXIMUM_VERSION}). Continuing because the CLI contract may still be compatible.`,
      ),
    };
  }
  return { version };
}
