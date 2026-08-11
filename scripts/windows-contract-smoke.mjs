import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

const root = await mkdtemp(path.join(os.tmpdir(), "pioneer-windows-smoke-"));
const source = path.join(root, "source");
await mkdir(source);
try {
  const review = spawnSync(
    process.execPath,
    ["dist/review-cli.js", "review", "--source", source, "--prompt", "Smoke test"],
    { encoding: "utf8", shell: false },
  );
  if (review.status !== 1 || !review.stderr.includes("--allow-unsandboxed-windows")) {
    throw new Error("Windows review did not require explicit unsandboxed opt-in");
  }

  const localAppData = path.join(root, "local-app-data");
  const optedIn = spawnSync(
    process.execPath,
    [
      "dist/review-cli.js",
      "review",
      "--source",
      source,
      "--prompt",
      "Smoke test",
      "--allow-unsandboxed-windows",
    ],
    {
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        PI_CODING_AGENT_DIR: path.join(root, "missing-pi-home"),
      },
    },
  );
  const marker = /^\[PIONEER_WORK_LOG\] (.+)$/m.exec(optedIn.stderr)?.[1]?.trim();
  const markerRelative =
    marker === undefined
      ? undefined
      : path.relative(path.resolve(localAppData), path.resolve(marker));
  if (
    optedIn.status === null ||
    optedIn.status === 0 ||
    !optedIn.stderr.includes("[PI_NOT_FOUND]") ||
    marker === undefined ||
    markerRelative === undefined ||
    markerRelative.startsWith("..") ||
    path.isAbsolute(markerRelative)
  ) {
    throw new Error(
      `Windows opted-in review did not reach observable readiness (${JSON.stringify({
        status: optedIn.status,
        signal: optedIn.signal,
        markerRelative,
      })}): ${optedIn.stderr}`,
    );
  }
  const workLog = (await readFile(marker, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  if (!workLog.some((record) => record.type === "review_started" && record.sandboxed === false)) {
    throw new Error("Windows opted-in review did not record its unsandboxed execution state");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write("Windows fail-closed and opt-in contracts passed\n");
