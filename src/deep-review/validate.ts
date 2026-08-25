export class DeepReviewValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "DeepReviewValidationError";
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNoExtraKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new DeepReviewValidationError(
        "DEEP_REVIEW_OUTPUT_INVALID",
        `${context} contains unknown field "${key}"`,
      );
    }
  }
}

export function requireString(
  value: unknown,
  field: string,
  context: string,
  options?: { maxLength?: number; pattern?: RegExp },
): string {
  if (typeof value !== "string") {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} must be a string`,
    );
  }
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} exceeds maximum length`,
    );
  }
  if (options?.pattern && !options.pattern.test(value)) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} has invalid format`,
    );
  }
  return value;
}

export function requireNumber(
  value: unknown,
  field: string,
  context: string,
  options?: { integer?: boolean; min?: number; max?: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} must be a finite number`,
    );
  }
  if (options?.integer && !Number.isInteger(value)) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} must be an integer`,
    );
  }
  if (options?.min !== undefined && value < options.min) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} is below minimum`,
    );
  }
  if (options?.max !== undefined && value > options.max) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} exceeds maximum`,
    );
  }
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  context: string,
  allowed: ReadonlySet<T>,
): T {
  const stringValue = requireString(value, field, context);
  if (!allowed.has(stringValue as T)) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} has invalid value`,
    );
  }
  return stringValue as T;
}

export function requireArray<T>(
  value: unknown,
  field: string,
  context: string,
  parseItem: (item: unknown, index: number) => T,
  options?: { maxLength?: number },
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} must be an array`,
    );
  }
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} exceeds maximum length`,
    );
  }
  return value.map((item, index) => parseItem(item, index));
}

export function optionalField<T>(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T,
): T | undefined {
  if (!(key in record)) return undefined;
  return parse(record[key]);
}

export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const REPO_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*\.\.)[^\0]+$/;

export function isValidRepoRelativePath(pathValue: string): boolean {
  for (let index = 0; index < pathValue.length; index += 1) {
    const code = pathValue.charCodeAt(index);
    if (code <= 0x1f) return false;
  }
  return REPO_RELATIVE_PATH_PATTERN.test(pathValue);
}

export function requireGitSha(value: unknown, field: string, context: string): string {
  return requireString(value, field, context, { pattern: GIT_SHA_PATTERN });
}

export function requireRepoRelativePath(value: unknown, field: string, context: string): string {
  const pathValue = requireString(value, field, context);
  if (!REPO_RELATIVE_PATH_PATTERN.test(pathValue) || !isValidRepoRelativePath(pathValue)) {
    throw new DeepReviewValidationError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      `${context}.${field} is not a valid repository-relative path`,
    );
  }
  return pathValue;
}
