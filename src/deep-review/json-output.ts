import { isRecord } from "./validate.js";

const JSON_FENCE_PATTERN = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const MAX_RAW_OUTPUT_BYTES = 256 * 1024;

export class StructuredOutputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "StructuredOutputError";
    this.code = code;
  }
}

export function extractRawJsonObject(
  text: string,
  maxBytes: number = MAX_RAW_OUTPUT_BYTES,
): unknown {
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    throw new StructuredOutputError(
      "DEEP_REVIEW_OUTPUT_INVALID",
      "model output exceeds byte limit",
    );
  }

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    if (!isRecord(direct)) {
      throw new StructuredOutputError(
        "DEEP_REVIEW_OUTPUT_INVALID",
        "model output must be a JSON object",
      );
    }
    return direct;
  }

  const fenceMatch = JSON_FENCE_PATTERN.exec(trimmed);
  if (fenceMatch?.[1] !== undefined) {
    const fenced = tryParseJson(fenceMatch[1].trim());
    if (fenced !== undefined) {
      if (!isRecord(fenced)) {
        throw new StructuredOutputError(
          "DEEP_REVIEW_OUTPUT_INVALID",
          "fenced model output must be a JSON object",
        );
      }
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const embedded = tryParseJson(candidate);
    if (embedded !== undefined) {
      if (!isRecord(embedded)) {
        throw new StructuredOutputError(
          "DEEP_REVIEW_OUTPUT_INVALID",
          "embedded model output must be a JSON object",
        );
      }
      return embedded;
    }
  }

  throw new StructuredOutputError("DEEP_REVIEW_OUTPUT_INVALID", "model output is not valid JSON");
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
