import { createDoctorReport, type DoctorReport } from "./doctor-report.js";
import { checkPiReadiness } from "./pi-readiness.js";
import { nativeSandboxReadinessErrors } from "./sandbox/platform-readiness.js";

export async function runDoctor(extensions = true): Promise<DoctorReport> {
  const strictErrors = await nativeSandboxReadinessErrors();
  const pi = await checkPiReadiness({ extensions });
  return createDoctorReport(process.platform, pi, strictErrors);
}
