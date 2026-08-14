import { CliUsageError, sanitizeDiagnostic } from "./diagnostics.js";
import { PiReadinessError } from "./pi-readiness.js";

export function cliErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof CliUsageError ||
    (error instanceof PiReadinessError && error.preserveCliMessage)
    ? message
    : sanitizeDiagnostic(message);
}
