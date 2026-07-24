import { type Diagnostic, parseDiagnostic } from "../diagnostics.js";
import type { PiReadiness } from "../pi-readiness.js";

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly platform: NodeJS.Platform;
  readonly supported: boolean;
  readonly pi: { readonly version: string | null; readonly modelCount: number };
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export function createDoctorReport(
  platform: NodeJS.Platform,
  pi: PiReadiness,
  strictErrors: readonly string[],
): DoctorReport {
  const errors = [...pi.errors, ...strictErrors];
  const warnings = pi.warning === undefined ? [] : [pi.warning];
  return {
    schemaVersion: 1,
    platform,
    supported: pi.ready && errors.length === 0,
    pi: { version: pi.version ?? null, modelCount: pi.modelCount },
    warnings,
    errors,
    diagnostics: [
      ...errors.map((message) => parseDiagnostic(message)),
      ...warnings.map((message) => parseDiagnostic(message, "warning")),
    ],
  };
}
