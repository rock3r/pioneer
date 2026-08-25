import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DeepReviewConfigV1 } from "./config.js";
import { assertNoExtraKeys, isRecord, requireArray, requireString } from "./validate.js";

export interface CapabilityProfileExtensionV1 {
  readonly id: string;
  readonly path: string;
  readonly digest?: string;
  readonly modelFacingTools?: readonly string[];
}

export interface CapabilityProfileV1 {
  readonly schemaVersion: "pioneer-capability-profile/v1";
  readonly extensions: readonly CapabilityProfileExtensionV1[];
}

const PROFILE_KEYS = new Set(["schemaVersion", "extensions"]);
const EXTENSION_KEYS = new Set(["id", "path", "digest", "modelFacingTools"]);

function parseCapabilityProfileExtension(
  value: unknown,
  context: string,
): CapabilityProfileExtensionV1 {
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, EXTENSION_KEYS, context);
  const modelFacingTools = optionalStringArray(value, "modelFacingTools", context);
  const digest = optionalString(value, "digest", context);
  return {
    id: requireString(value.id, "id", context, { maxLength: 128 }),
    path: requireString(value.path, "path", context, { maxLength: 4096 }),
    ...(digest !== undefined ? { digest } : {}),
    ...(modelFacingTools !== undefined ? { modelFacingTools } : {}),
  };
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  if (!(key in record)) return undefined;
  return requireString(record[key], key, context);
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  context: string,
): readonly string[] | undefined {
  if (!(key in record)) return undefined;
  return requireArray(record[key], key, context, (item) =>
    requireString(item, `${key}[]`, context, { maxLength: 128 }),
  );
}

export function parseCapabilityProfile(value: unknown): CapabilityProfileV1 {
  const context = "capabilityProfile";
  if (!isRecord(value)) {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context} must be an object`);
  }
  assertNoExtraKeys(value, PROFILE_KEYS, context);
  const schemaVersion = requireString(value.schemaVersion, "schemaVersion", context);
  if (schemaVersion !== "pioneer-capability-profile/v1") {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] ${context}.schemaVersion is unsupported`);
  }
  return {
    schemaVersion: "pioneer-capability-profile/v1",
    extensions: requireArray(value.extensions, "extensions", context, (item, index) =>
      parseCapabilityProfileExtension(item, `${context}.extensions[${index}]`),
    ),
  };
}

export function rejectModelFacingTools(extension: CapabilityProfileExtensionV1): void {
  if (extension.modelFacingTools !== undefined && extension.modelFacingTools.length > 0) {
    throw new Error(
      `[DEEP_REVIEW_CONFIG_INVALID] extension ${extension.id} declares model-facing tools`,
    );
  }
}

function overlapsGrant(candidate: string, grant: string): boolean {
  const relative = path.relative(grant, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function validateExtensionPath(
  extensionPath: string,
  forbiddenPaths: readonly string[],
  expectedDigest?: string,
): Promise<string> {
  if (!path.isAbsolute(extensionPath)) {
    throw new Error("[DEEP_REVIEW_CONFIG_INVALID] extension path must be absolute");
  }
  let canonical: string;
  try {
    canonical = await realpath(extensionPath);
  } catch {
    throw new Error(`[DEEP_REVIEW_CONFIG_INVALID] extension path does not exist: ${extensionPath}`);
  }
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new Error("[DEEP_REVIEW_CONFIG_INVALID] extension path must be a regular file");
  }
  await access(canonical, constants.R_OK);
  if (expectedDigest !== undefined) {
    const contents = await readFile(canonical);
    const actualDigest = createHash("sha256").update(contents).digest("hex");
    if (actualDigest !== expectedDigest.toLowerCase()) {
      throw new Error("[DEEP_REVIEW_CONFIG_INVALID] extension digest mismatch");
    }
  }
  for (const forbidden of forbiddenPaths) {
    if (overlapsGrant(canonical, forbidden) || overlapsGrant(forbidden, canonical)) {
      throw new Error("[DEEP_REVIEW_CONFIG_INVALID] extension path overlaps forbidden grant");
    }
  }
  return canonical;
}

function isSha256Hex(digest: string): boolean {
  return /^[0-9a-f]{64}$/i.test(digest);
}

export async function validateCapabilityProfilePath(
  profilePath: string,
  forbiddenPaths: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(profilePath)) {
    throw new Error("[DEEP_REVIEW_CONFIG_INVALID] capability profile path must be absolute");
  }
  let canonical: string;
  try {
    canonical = await realpath(profilePath);
  } catch {
    throw new Error(
      `[DEEP_REVIEW_CONFIG_INVALID] capability profile path does not exist: ${profilePath}`,
    );
  }
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new Error("[DEEP_REVIEW_CONFIG_INVALID] capability profile path must be a regular file");
  }
  await access(canonical, constants.R_OK);
  for (const forbidden of forbiddenPaths) {
    const forbiddenCanonical = await realpath(forbidden);
    if (
      overlapsGrant(canonical, forbiddenCanonical) ||
      overlapsGrant(forbiddenCanonical, canonical)
    ) {
      throw new Error(
        "[DEEP_REVIEW_CONFIG_INVALID] capability profile path overlaps forbidden grant",
      );
    }
  }
  return canonical;
}

export async function resolveSelectedCapabilityExtensions(
  config: DeepReviewConfigV1,
  forbiddenPaths: readonly string[],
): Promise<readonly string[]> {
  const selection = config.capabilityProfile;
  if (selection === undefined) return [];

  const profilePath = await validateCapabilityProfilePath(selection.path, forbiddenPaths);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(profilePath, "utf8"));
  } catch {
    throw new Error("[DEEP_REVIEW_CONFIG_INVALID] capability profile could not be read");
  }

  const profile = parseCapabilityProfile(raw);
  const selectedIds = new Set(selection.extensionIds);
  const resolved: string[] = [];

  for (const extension of profile.extensions) {
    if (!selectedIds.has(extension.id)) continue;
    rejectModelFacingTools(extension);
    if (extension.digest === undefined) {
      throw new Error("[DEEP_REVIEW_CONFIG_INVALID] extension digest is required");
    }
    if (!isSha256Hex(extension.digest)) {
      throw new Error("[DEEP_REVIEW_CONFIG_INVALID] extension digest must be 64 lowercase hex");
    }
    resolved.push(await validateExtensionPath(extension.path, forbiddenPaths, extension.digest));
    selectedIds.delete(extension.id);
  }

  if (selectedIds.size > 0) {
    throw new Error(
      "[DEEP_REVIEW_CONFIG_INVALID] capability profile missing selected extension IDs",
    );
  }

  return resolved;
}
