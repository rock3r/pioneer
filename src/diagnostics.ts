export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

const DIAGNOSTIC_PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s+(.*)$/s;
const MAX_SERIALIZATION_DEPTH = 16;
const CREDENTIAL_CORE =
  "(?:authorization|api[-_ ]?key|private[-_ ]?key|access[-_ ]?key[-_ ]?id|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret[-_ ]?access[-_ ]?key|session(?:[-_ ]?(?:id|token))?|connection[-_ ]?string|cookie|passphrase|credential|signature|sig|key|token|password|secret)";
const SECRET_LABEL = `(?:[a-z0-9]+[-_.:/ ])*[a-z0-9]*${CREDENTIAL_CORE}[a-z0-9]*(?:[-_.:/ ][a-z0-9]+)*`;
const QUOTED_LABEL_CANDIDATE =
  "(?:[a-z0-9]|\\\\u[0-9a-f]{4})(?:[a-z0-9._:/@+ -]|\\\\u[0-9a-f]{4})*";
const CREDENTIAL_TOKENS = new Set([
  "authorization",
  "cookie",
  "credential",
  "key",
  "passphrase",
  "password",
  "session",
  "sig",
  "signature",
  "secret",
  "token",
]);
const COMPOUND_CREDENTIAL_SUFFIXES = [
  "apikey",
  "privatekey",
  "accesskeyid",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "secretaccesskey",
  "sessionid",
  "sessiontoken",
  "connectionstring",
  "authtoken",
  "accountkey",
  "secretkey",
  "webhooksecret",
  "signingkey",
  "signingsecret",
] as const;
const STANDALONE_CREDENTIAL_SOURCE = String.raw`\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{16,})\b`;

function credentialLabelTokens(label: string): readonly string[] {
  return label
    .replaceAll(/\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_.:/@+\s]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase().replace(/\d+$/, ""));
}

function isCredentialLabel(label: string): boolean {
  const tokens = credentialLabelTokens(label);
  if (tokens.some((token) => CREDENTIAL_TOKENS.has(token))) return true;
  const joined = tokens.join("");
  return COMPOUND_CREDENTIAL_SUFFIXES.some((suffix) => joined.endsWith(suffix));
}

export function containsCredentialAssignment(value: string): boolean {
  return [...value.matchAll(/\b([A-Za-z0-9][A-Za-z0-9._/@+-]*)\s*[:=]/g)].some((match) =>
    isCredentialLabel(match[1] ?? ""),
  );
}

export function containsStandaloneCredential(value: string): boolean {
  return new RegExp(STANDALONE_CREDENTIAL_SOURCE).test(value);
}

function redactQuotedCredentialAssignments(value: string): string {
  const broadQuotedLabels = value.replaceAll(
    new RegExp(
      `(["'])(${QUOTED_LABEL_CANDIDATE})\\1\\s*[:=]\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
      "gi",
    ),
    (match, quote: string, label: string) =>
      isCredentialLabel(label) ? `${quote}${label}${quote}=[REDACTED]` : match,
  );
  return broadQuotedLabels.replaceAll(
    new RegExp(
      `(["']?)\\b(${SECRET_LABEL})\\1\\s*[:=]\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
      "gi",
    ),
    (match, quote: string, label: string) =>
      isCredentialLabel(label) ? `${quote}${label}${quote}=[REDACTED]` : match,
  );
}

function redactUnquotedCredentialLines(value: string): string {
  return value.replaceAll(
    new RegExp(`(["']?)\\b(${SECRET_LABEL})\\1\\s*[:=]\\s*(?!["']|\\[REDACTED\\])[^\\r\\n]*`, "gi"),
    (match, quote: string, label: string) =>
      isCredentialLabel(label) ? `${quote}${label}${quote}=[REDACTED]` : match,
  );
}

function redactFoldedCredentialHeaders(value: string): string {
  return value.replaceAll(
    new RegExp(
      `\\b(${SECRET_LABEL})\\s*:\\s*(?!["']|\\[REDACTED\\])[^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)+`,
      "gi",
    ),
    (match, label: string) => (isCredentialLabel(label) ? `${label}=[REDACTED]` : match),
  );
}

function unescapeSerializedDelimiterLayer(value: string): string {
  return value.replaceAll(
    /\\([/"'])|\\(\\)(?=\\?(?:[/"']|u[0-9a-f]{4}))/gi,
    (_match: string, delimiter: string | undefined, serializedBackslash: string | undefined) =>
      delimiter ?? serializedBackslash ?? "",
  );
}

function redactSerializedCredentialAssignments(value: string): string {
  let sanitized = value;
  for (let depth = 0; depth < MAX_SERIALIZATION_DEPTH; depth += 1) {
    sanitized = redactUnquotedCredentialLines(
      redactQuotedCredentialAssignments(redactFoldedCredentialHeaders(sanitized)),
    );
    const unescaped = unescapeSerializedDelimiterLayer(sanitized);
    if (unescaped === sanitized) return sanitized;
    sanitized = unescaped;
  }
  return redactUnquotedCredentialLines(
    redactQuotedCredentialAssignments(redactFoldedCredentialHeaders(sanitized)),
  );
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

function redactSignedUrlCredentials(value: string): string {
  return value.replaceAll(
    /((?:[?&]|%3f|%26|\\u0026|&(?:amp|#0*38|#x0*26);)(?:(?:x-amz|x-goog)-)?(?:credential|signature|security-token|sig)(?:=|%3d))(?:(?![&#\s,"'{}]|%26|\\["']|\\u0026).)+/gi,
    "$1[REDACTED]",
  );
}

function redactPercentEncodedQueryCredentials(value: string): string {
  return value.replaceAll(
    /((?:%3f|%26)((?:(?!%3d)[a-z0-9._@+%-])+)%3d)(?:(?![&#\s,"'{}]|%26|\\["']|\\u0026).)+/gi,
    (match, prefix: string, encodedLabel: string) => {
      try {
        return isCredentialLabel(decodeURIComponent(encodedLabel)) ? `${prefix}[REDACTED]` : match;
      } catch {
        return match;
      }
    },
  );
}

function redactQueryCredentials(value: string): string {
  return value.replaceAll(
    /((?:&(?:amp|#0*38|#x0*26);|[?&])([a-z0-9._/@+%:-]+)=)(?:(?![&#\s,"'{}]|\\["']|\\u0026).)+/gi,
    (match, prefix: string, encodedLabel: string) => {
      try {
        return isCredentialLabel(decodeURIComponent(encodedLabel)) ? `${prefix}[REDACTED]` : match;
      } catch {
        return match;
      }
    },
  );
}

function redactPercentEncodedUrlUserinfo(value: string): string {
  return value.replaceAll(
    /((?:[a-z][a-z0-9+.-]*)%3a%2f%2f)(?:(?![&#\s,"'{}]|%2f|%3f|%23).)+%40/gi,
    "$1[REDACTED]%40",
  );
}

export class CliUsageError extends Error {}

export function diagnosticMessage(id: string, message: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw new Error(`Invalid diagnostic ID: ${id}`);
  return `[${id}] ${message}`;
}

export function sanitizeDiagnostic(value: string, secrets: readonly string[] = []): string {
  let sanitized = redactSerializedCredentialAssignments(
    redactPercentEncodedQueryCredentials(
      redactQueryCredentials(
        redactSignedUrlCredentials(
          redactPercentEncodedUrlUserinfo(
            value.replaceAll(
              /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----|$)/gi,
              "[REDACTED]",
            ),
          ),
        ),
      ),
    ),
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
      /((?:\b[a-z][a-z0-9+.-]*:)?\/\/)[^/\s?#,"'{}[\]<>]+@/gi,
      (_match, authorityPrefix: string) => `${authorityPrefix}[REDACTED]@`,
    )
    .replaceAll(/\bbearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replaceAll(
      new RegExp(`(["']?)\\b(${SECRET_LABEL})\\1\\s*[:=]\\s*(?!\\[REDACTED\\])[^\\s,;]+`, "gi"),
      (match, quote: string, label: string) =>
        isCredentialLabel(label) ? `${quote}${label}${quote}=[REDACTED]` : match,
    )
    .replaceAll(new RegExp(STANDALONE_CREDENTIAL_SOURCE, "g"), "[REDACTED]")
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
