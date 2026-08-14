export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

const DIAGNOSTIC_PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s+(.*)$/s;
const MAX_SERIALIZATION_DEPTH = 16;
const SECRET_LABEL =
  "(?:[a-z0-9]+[-_.:/ ])*[a-z0-9]*(?:api[-_ ]?key|private[-_ ]?key|access[-_ ]?key[-_ ]?id|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret[-_ ]?access[-_ ]?key|session(?:[-_ ]?(?:id|token))?|cookie|passphrase|token|password|secret)";

function redactQuotedCredentialAssignments(value: string): string {
  return value.replaceAll(
    new RegExp(
      `(["']?)\\b(${SECRET_LABEL})\\1\\s*[:=]\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
      "gi",
    ),
    (_match, quote: string, label: string) => `${quote}${label}${quote}=[REDACTED]`,
  );
}

function redactUnquotedPassphrase(value: string): string {
  return value.replaceAll(
    /(["']?)\b(?:[a-z0-9]+[-_.:/ ])*[a-z0-9]*passphrase\1\s*[:=]\s*(?!["']|\[REDACTED\])[^\r\n]*/gi,
    "PASSPHRASE=[REDACTED]",
  );
}

function unescapeSerializedDelimiterLayer(value: string): string {
  return value.replaceAll(/\\([\\/"'])/g, "$1");
}

function redactSerializedCredentialAssignments(value: string): string {
  let sanitized = value;
  for (let depth = 0; depth < MAX_SERIALIZATION_DEPTH; depth += 1) {
    sanitized = redactUnquotedPassphrase(redactQuotedCredentialAssignments(sanitized));
    const unescaped = unescapeSerializedDelimiterLayer(sanitized);
    if (unescaped === sanitized) return sanitized;
    sanitized = unescaped;
  }
  return redactUnquotedPassphrase(redactQuotedCredentialAssignments(sanitized));
}

function unescapeSerializedDelimiters(value: string): string {
  let unescaped = value;
  for (let depth = 0; depth < MAX_SERIALIZATION_DEPTH; depth += 1) {
    const next = unescapeSerializedDelimiterLayer(unescaped);
    if (next === unescaped) return unescaped;
    unescaped = next;
  }
  return unescaped;
}

export class CliUsageError extends Error {}

export function diagnosticMessage(id: string, message: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw new Error(`Invalid diagnostic ID: ${id}`);
  return `[${id}] ${message}`;
}

export function sanitizeDiagnostic(value: string, secrets: readonly string[] = []): string {
  let sanitized = redactSerializedCredentialAssignments(value)
    .replaceAll(
      /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----|$)/gi,
      "[REDACTED]",
    )
    .replaceAll(
      /(["']?)\b(?:proxy[-_ ]?)?authorization\1\s*[:=][^\r\n]*/gi,
      "Authorization=[REDACTED]",
    )
    .replaceAll(/(["']?)\b(?:set-cookie|cookie)\1\s*[:=][^\r\n]*/gi, "Cookie=[REDACTED]")
    .replaceAll(
      /(["']?)\b(?:[a-z0-9]+_)*connection[-_ ]?string\1\s*[:=][^\r\n]*/gi,
      "CONNECTION_STRING=[REDACTED]",
    );
  sanitized = sanitized.replaceAll(/\s+/g, " ");
  for (const secret of secrets) {
    const variants = [secret, JSON.stringify(secret).slice(1, -1)];
    for (const variant of variants) {
      const normalized = unescapeSerializedDelimiters(variant).replaceAll(/\s+/g, " ").trim();
      if (normalized) sanitized = sanitized.replaceAll(normalized, "[REDACTED]");
    }
  }
  return redactQuotedCredentialAssignments(sanitized)
    .replaceAll(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
      (_match, scheme: string) => `${scheme}[REDACTED]@`,
    )
    .replaceAll(
      /((?:[?&]|\\u0026|&(?:amp|#0*38|#x0*26);)(?:(?:x-amz|x-goog)-)?(?:credential|signature|security-token|sig)=)(?:(?![&#\s]|\\u0026).)+/gi,
      "$1[REDACTED]",
    )
    .replaceAll(/\bbearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replaceAll(
      new RegExp(`(["']?)\\b(${SECRET_LABEL})\\1\\s*[:=]\\s*[^\\s,;]+`, "gi"),
      (_match, quote: string, label: string) => `${quote}${label}${quote}=[REDACTED]`,
    )
    .replaceAll(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
      "[REDACTED]",
    )
    .trim()
    .slice(0, 500);
}

export function parseDiagnostic(
  message: string,
  severity: DiagnosticSeverity = "error",
): Diagnostic {
  const match = DIAGNOSTIC_PREFIX.exec(message);
  return match === null
    ? { id: "UNCLASSIFIED_ERROR", severity, message }
    : { id: match[1] ?? "UNCLASSIFIED_ERROR", severity, message: match[2] ?? message };
}
