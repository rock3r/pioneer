import { sanitizeDiagnostic } from "../diagnostics.js";

/**
 * Classifies a sanitized assistant or provider failure into a stable cause.
 *
 * Evidence is the text Pi already put on the RPC stream or stderr. This module
 * never contacts a provider, never reads a credential store, and never invents
 * a cause when that text does not match a known class.
 */

export const FAILURE_CAUSE_CLASSES = [
  "auth_refresh",
  "missing_credentials",
  "quota_or_rate_limit",
  "unsupported_model",
  "transport",
  "timeout_or_cancellation",
  "missing_report",
  "unclassified",
] as const;

export type FailureCauseClass = (typeof FAILURE_CAUSE_CLASSES)[number];

export interface FailureCauseContext {
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
  readonly status?: number;
  readonly providerCode?: string;
}

export interface ClassifiedFailureCause {
  readonly cause: FailureCauseClass;
  readonly summary: string;
  readonly guidance: string;
  readonly context: FailureCauseContext;
}

const MAX_SUMMARY_LENGTH = 240;

const GUIDANCE: Readonly<Record<FailureCauseClass, string>> = {
  auth_refresh:
    "Re-authenticate this provider in normal Pi, then retry. Pioneer does not refresh credentials or change billing routes.",
  missing_credentials:
    "Configure this provider in normal Pi, then retry. Pioneer does not select another provider.",
  quota_or_rate_limit:
    "Wait and retry, or raise the provider quota. Pioneer does not switch billing routes.",
  unsupported_model:
    "Request a model this provider serves. Pioneer does not substitute another model.",
  transport:
    "Retry when the provider is reachable. Pioneer does not switch providers or billing routes.",
  timeout_or_cancellation:
    "Retry the review. A timeout is not a completed review, and reading a file is not one either.",
  missing_report:
    "Pi settled without a review report. Retry the review; a file read or ping is not a completed review.",
  unclassified:
    "Pioneer has no classified cause for this failure. Inspect the work log metadata; do not assume an outage or a credential problem.",
};

interface CauseRule {
  readonly cause: Exclude<FailureCauseClass, "unclassified" | "missing_report">;
  readonly pattern: RegExp;
}

/**
 * Order matters. A reused refresh token is an auth failure even when the body
 * also contains "401", and a missing credential is not an expired refresh.
 */
const CAUSE_RULES: readonly CauseRule[] = [
  {
    cause: "auth_refresh",
    pattern:
      /refresh[_\s-]?token[_\s-]?reused|\boauth refresh\b|pi_oauth_refresh_failed|refresh through pioneer failed|credential store modify failed|invalid_grant|token has expired|refresh token has already been used/i,
  },
  {
    cause: "missing_credentials",
    pattern:
      /credentials?[_\s-]?not[_\s-]?configured|no credentials? (?:configured|found)|missing credentials?|not authenticated|auth(?:entication)? required/i,
  },
  {
    cause: "quota_or_rate_limit",
    pattern:
      /rate[_\s-]?limit|too many requests|\b429\b|quota exceeded|insufficient[_\s-]?quota|billing hard limit|resource exhausted/i,
  },
  {
    cause: "unsupported_model",
    pattern:
      /model(?:_not_found| not found)|unsupported model|does not (?:support|serve) (?:this )?model|unknown model|model [`'][^`']+[`'] was not found/i,
  },
  {
    cause: "timeout_or_cancellation",
    pattern:
      /\btimed out\b|\btimeout\b|\btimed-out\b|context deadline exceeded|\brequest (?:aborted|cancelled|canceled)\b/i,
  },
  {
    cause: "transport",
    pattern:
      /\b(?:econnreset|econnrefused|enotfound|etimedout|eai_again|enetunreach|ehostunreach|fetch failed|network error|socket hang up)\b/i,
  },
];

function field(text: string, name: string): string | undefined {
  const labelled = new RegExp(`\\b${name}\\s*[:=]\\s*([A-Za-z0-9][A-Za-z0-9._-]{0,80})`, "i").exec(
    text,
  )?.[1];
  // `for openai` names a provider. Applying it to model or API would invent those fields.
  const fallback =
    name === "provider" ? /\bfor\s+([A-Za-z0-9][A-Za-z0-9._-]{0,80})/i.exec(text)?.[1] : undefined;
  const value = labelled ?? fallback;
  return value === undefined || value.toLowerCase() === "null" ? undefined : value;
}

function statusCode(text: string): number | undefined {
  const labelled = /\b(?:status|http)\s*[:=]?\s*(\d{3})\b/i.exec(text)?.[1];
  const parenthetical = /\((\d{3})\)/.exec(text)?.[1];
  const bare = /\b(?:401|402|403|404|408|409|429|500|502|503|504)\b/.exec(text)?.[0];
  const raw = labelled ?? parenthetical ?? bare;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return parsed >= 400 && parsed <= 599 ? parsed : undefined;
}

function providerCode(text: string): string | undefined {
  const jsonCode = /"code"\s*:\s*"([A-Za-z0-9_]+)"/.exec(text)?.[1];
  if (jsonCode !== undefined) return jsonCode;
  const labelled = /\bcode=([A-Za-z0-9_]+)/.exec(text)?.[1];
  if (labelled !== undefined) return labelled;
  const known = /\b(refresh_token_reused|invalid_grant|credentials_not_configured)\b/.exec(
    text,
  )?.[1];
  if (known !== undefined) return known;
  return /\[(PI_[A-Z0-9_]+)\]/.exec(text)?.[1];
}

function contextFrom(text: string, supplied: FailureCauseContext): FailureCauseContext {
  const provider = supplied.provider ?? field(text, "provider");
  const model = supplied.model ?? field(text, "model");
  const api = supplied.api ?? field(text, "api");
  const status = supplied.status ?? statusCode(text);
  const code = supplied.providerCode ?? providerCode(text);
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(api === undefined ? {} : { api }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { providerCode: code }),
  };
}

function summaryFrom(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_SUMMARY_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

/**
 * `sanitizeDiagnostic` treats `label:` as a credential assignment and consumes
 * the rest of the line. A provider id such as `openai-codex:` is not one.
 * Protect those spans so the status and provider code after them survive.
 */
function protectProviderLabels(text: string): {
  readonly text: string;
  readonly restore: (value: string) => string;
} {
  const saved: string[] = [];
  const protectedText = text.replaceAll(
    /\b((?:openai-codex|openai|anthropic|google|zai|openrouter)[A-Za-z0-9._-]*):(?=\s)/gi,
    (match) => {
      saved.push(match);
      return `providerlabel${saved.length - 1}label`;
    },
  );
  return {
    text: protectedText,
    restore: (value) =>
      value.replaceAll(
        /providerlabel(\d+)label/g,
        (_match, index: string) => saved[Number(index)] ?? "",
      ),
  };
}

export function classifyFailureCause(
  evidence: string | undefined,
  supplied: FailureCauseContext = {},
  fallback: FailureCauseClass = "unclassified",
): ClassifiedFailureCause {
  const text = evidence?.trim() ?? "";
  if (text.length === 0) {
    return {
      cause: fallback,
      summary: "",
      guidance: GUIDANCE[fallback],
      context: contextFrom("", supplied),
    };
  }
  const protectedText = protectProviderLabels(text);
  const sanitized = protectedText.restore(sanitizeDiagnostic(protectedText.text));
  const matched = CAUSE_RULES.find((rule) => rule.pattern.test(sanitized));
  const cause = matched?.cause ?? fallback;
  return {
    cause,
    summary: summaryFrom(sanitized),
    guidance: GUIDANCE[cause],
    context: contextFrom(sanitized, supplied),
  };
}

export function formatFailureCause(classified: ClassifiedFailureCause): string {
  const parts = [`cause=${classified.cause}`];
  const { context } = classified;
  if (context.provider !== undefined) parts.push(`provider=${context.provider}`);
  if (context.model !== undefined) parts.push(`model=${context.model}`);
  if (context.api !== undefined) parts.push(`api=${context.api}`);
  if (context.status !== undefined) parts.push(`status=${context.status}`);
  if (context.providerCode !== undefined) parts.push(`code=${context.providerCode}`);
  if (classified.summary.length > 0) parts.push(`detail=${classified.summary}`);
  parts.push(`guidance=${classified.guidance}`);
  return parts.join("; ");
}
