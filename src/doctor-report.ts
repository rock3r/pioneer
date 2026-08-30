import { type Diagnostic, parseDiagnostic } from "./diagnostics.js";
import type { PiReadiness } from "./pi-readiness.js";

export const PIONEER_OUTER_SANDBOX_REQUIRED_WARNING =
  "[PIONEER_OUTER_SANDBOX_REQUIRED] Pioneer must run outside any enclosing agent sandbox so the controller can access Pi configuration and the configured provider. This does not weaken Pioneer's native sandbox for review and eval actors.";

const OUTER_SANDBOX_RELATED_DIAGNOSTICS = new Set([
  "PI_MODELS_CONFIG_INVALID",
  "PI_CONFIG_HIDDEN_BY_SANDBOX",
]);

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
  const outerSandboxHintRequired = errors.some((error) =>
    OUTER_SANDBOX_RELATED_DIAGNOSTICS.has(parseDiagnostic(error).id),
  );
  const warnings = [
    ...(pi.warning === undefined ? [] : [pi.warning]),
    ...(outerSandboxHintRequired ? [PIONEER_OUTER_SANDBOX_REQUIRED_WARNING] : []),
  ];
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
