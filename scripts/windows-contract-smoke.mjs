import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") throw new Error("Windows contract smoke requires Windows");

const doctor = spawnSync(process.execPath, ["dist/review-cli.js", "doctor"], {
  encoding: "utf8",
  shell: false,
});
if (doctor.status !== 1) throw new Error(`Windows doctor unexpectedly exited ${doctor.status}`);
const report = JSON.parse(doctor.stdout);
if (
  report.schemaVersion !== 1 ||
  !report.diagnostics?.some(
    (diagnostic) => diagnostic.id === "WINDOWS_STRICT_ISOLATION_UNAVAILABLE",
  )
) {
  throw new Error("Windows doctor did not report its stable fail-closed diagnostic");
}

const source = await mkdtemp(path.join(os.tmpdir(), "pioneer-windows-smoke-"));
try {
  const review = spawnSync(
    process.execPath,
    ["dist/review-cli.js", "review", "--source", source, "--prompt", "Smoke test"],
    { encoding: "utf8", shell: false },
  );
  if (review.status !== 1 || !review.stderr.includes("--allow-unsandboxed-windows")) {
    throw new Error("Windows review did not require explicit unsandboxed opt-in");
  }
} finally {
  await rm(source, { recursive: true, force: true });
}

process.stdout.write("Windows fail-closed contracts passed\n");
