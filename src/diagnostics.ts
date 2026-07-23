export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

const DIAGNOSTIC_PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s+(.*)$/s;

export function diagnosticMessage(id: string, message: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw new Error(`Invalid diagnostic ID: ${id}`);
  return `[${id}] ${message}`;
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
