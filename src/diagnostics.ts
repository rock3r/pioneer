export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

const DIAGNOSTIC_PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s+(.*)$/s;

export class CliUsageError extends Error {}

export function diagnosticMessage(id: string, message: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw new Error(`Invalid diagnostic ID: ${id}`);
  return `[${id}] ${message}`;
}

export function sanitizeDiagnostic(value: string, secrets: readonly string[] = []): string {
  let sanitized = value
    .replaceAll(/\\+(?=[/"'])/g, "")
    .replaceAll(
      /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]*PRIVATE KEY)-----|$)/gi,
      "[REDACTED]",
    )
    .replaceAll(
      /(["']?)\bauthorization\1\s*[:=]\s*["']?(?:digest|aws4-hmac-sha256)\b[^\r\n]*/gi,
      "Authorization=[REDACTED]",
    )
    .replaceAll(
      /(["']?)\bauthorization\1\s*[:=]\s*(?!\[REDACTED\])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+(?:\s+[^\s,;]+)?)/gi,
      "Authorization=[REDACTED]",
    );
  sanitized = sanitized.replaceAll(/\s+/g, " ");
  for (const secret of secrets) {
    const variants = [secret, JSON.stringify(secret).slice(1, -1)];
    for (const variant of variants) {
      const normalized = variant.replaceAll(/\s+/g, " ").trim();
      if (normalized) sanitized = sanitized.replaceAll(normalized, "[REDACTED]");
    }
  }
  const secretLabel =
    "(?:[a-z0-9]+_)*(?:api[-_ ]?key|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret[-_ ]?access[-_ ]?key|token|password|secret)";
  return sanitized
    .replaceAll(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
      (_match, scheme: string) => `${scheme}[REDACTED]@`,
    )
    .replaceAll(
      new RegExp(
        `(["']?)\\b(${secretLabel})\\1\\s*[:=]\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
        "gi",
      ),
      (_match, quote: string, label: string) => `${quote}${label}${quote}=[REDACTED]`,
    )
    .replaceAll(/\bbearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replaceAll(
      new RegExp(`(["']?)\\b(${secretLabel})\\1\\s*[:=]\\s*[^\\s,;]+`, "gi"),
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
