import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(scriptPath));
const probe = process.argv.find((value) => value.startsWith("--probe="))?.slice("--probe=".length);

if (process.platform !== "win32") {
  process.stdout.write("windows-process-identity-bench: skipped (not win32)\n");
  process.exit(0);
}

const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
  throw new Error("Windows system root must be an absolute path");
}

const pid = String(process.pid);
const childEnv = {
  ...process.env,
  PIONEER_RETENTION_OWNER_PID: pid,
  SystemRoot: systemRoot,
};

function roundMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function summarizeSpawn(name, command, args, result, startedAt) {
  const stdout = (result.stdout ?? "").trim().replaceAll("\r\n", "\n");
  return {
    name,
    ms: roundMs(startedAt),
    command: path.win32.basename(command),
    status: result.status,
    signal: result.signal,
    pidInArgv: args.join(" ").includes(pid),
    stdoutPreview: stdout.slice(0, 160),
    stderrPreview: (result.stderr ?? "").trim().slice(0, 160),
    error: result.error?.message,
  };
}

function runSpawn(name, command, args) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: childEnv,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  return summarizeSpawn(name, command, args, result, startedAt);
}

function powershellLookup(executable, name) {
  return runSpawn(name, executable, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[DateTimeOffset]::new((Get-Process -Id ([int]$env:PIONEER_RETENTION_OWNER_PID) -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()",
  ]);
}

function wmicCreationDateArgs(processId) {
  return ["process", "where", `ProcessId=${processId}`, "get", "CreationDate", "/value"];
}

async function probeProductionLookup() {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "src", "review", "work-log.ts")).href;
  const startedAt = performance.now();
  const { windowsProcessInstanceIdentities } = await import(moduleUrl);
  const identities = windowsProcessInstanceIdentities(process.pid);
  const firstMs = roundMs(startedAt);
  const cachedAt = performance.now();
  const { currentProcessInstanceIdentities, processInstanceIdentities } = await import(moduleUrl);
  const cached = currentProcessInstanceIdentities("win32");
  const cachedMs = roundMs(cachedAt);
  const otherAt = performance.now();
  const other = processInstanceIdentities(2_147_483_647, "win32");
  process.stdout.write(
    `${JSON.stringify({
      probe: "production-lookup",
      firstLookupMs: firstMs,
      cachedLookupMs: cachedMs,
      otherPidLookupMs: roundMs(otherAt),
      firstOk: identities !== undefined,
      cachedSame: cached === identities,
      otherDefined: other !== undefined,
      identityCount: identities?.length,
    })}\n`,
  );
}

async function probeArchiveSplit() {
  const workLogUrl = pathToFileURL(path.join(repoRoot, "src", "review", "work-log.ts")).href;
  const archiveUrl = pathToFileURL(path.join(repoRoot, "src", "review", "resume-archive.ts")).href;
  const { currentProcessInstanceIdentities } = await import(workLogUrl);
  const { createReviewResumeArchive } = await import(archiveUrl);
  const root = mkdtempSync(path.join(os.tmpdir(), "pioneer-identity-bench-"));
  try {
    const lookupAt = performance.now();
    const identities = currentProcessInstanceIdentities("win32");
    const lookupMs = roundMs(lookupAt);
    const firstArchiveAt = performance.now();
    await createReviewResumeArchive(path.join(root, "displaced"), {
      sourceDir: "/repo",
      prompt: "displaced",
      network: "none",
      piVersion: "0.84.2",
    });
    const firstArchiveMs = roundMs(firstArchiveAt);
    const secondArchiveAt = performance.now();
    await createReviewResumeArchive(path.join(root, "contender"), {
      sourceDir: "/repo",
      prompt: "contender",
      network: "none",
      piVersion: "0.84.2",
    });
    process.stdout.write(
      `${JSON.stringify({
        probe: "archive-split",
        lookupMs,
        firstArchiveAfterWarmLookupMs: firstArchiveMs,
        secondArchiveMs: roundMs(secondArchiveAt),
        lookupOk: identities !== undefined,
      })}\n`,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runChildProbe(probeName) {
  const startedAt = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", scriptPath, `--probe=${probeName}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  const parsed = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);
  return {
    probe: probeName,
    childMs: roundMs(startedAt),
    status: result.status,
    stderrPreview: (result.stderr ?? "").trim().slice(0, 240),
    error: result.error?.message,
    result: parsed === undefined ? undefined : JSON.parse(parsed),
  };
}

if (probe === "production-lookup") {
  await probeProductionLookup();
  process.exit(0);
}
if (probe === "archive-split") {
  await probeArchiveSplit();
  process.exit(0);
}

const powershell = path.win32.join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const cmd = path.win32.join(systemRoot, "System32", "cmd.exe");
const cscript = path.win32.join(systemRoot, "System32", "cscript.exe");
const wmic = path.win32.join(systemRoot, "System32", "wbem", "wmic.exe");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pioneer-identity-candidates-"));
const cscriptFile = path.join(tempRoot, "process-start.js");
writeFileSync(
  cscriptFile,
  [
    'var pid = new ActiveXObject("WScript.Shell").Environment("Process")("PIONEER_RETENTION_OWNER_PID");',
    "if (!/^[1-9][0-9]{0,15}$/.test(pid)) WScript.Quit(1);",
    'var items = GetObject("winmgmts:").ExecQuery("SELECT CreationDate FROM Win32_Process WHERE ProcessId=" + pid);',
    "var enumerator = new Enumerator(items);",
    "if (enumerator.atEnd()) WScript.Quit(1);",
    "var created = enumerator.item().CreationDate;",
    'if (created == null || String(created) === "") WScript.Quit(1);',
    "WScript.StdOut.Write(created);",
    "",
  ].join("\r\n"),
  { flag: "wx" },
);

const candidates = [];
try {
  candidates.push(
    runSpawn("cmd-echo-baseline", cmd, ["/d", "/s", "/c", "echo ok"]),
    powershellLookup(powershell, "powershell-get-process"),
    runSpawn("pwsh-get-process", "pwsh.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[DateTimeOffset]::new((Get-Process -Id ([int]$env:PIONEER_RETENTION_OWNER_PID) -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()",
    ]),
    runSpawn("cscript-wmi", cscript, ["//Nologo", "//B", "//E:JScript", "//T:8", cscriptFile]),
    runSpawn("cmd-wmic-env-pid", cmd, [
      "/d",
      "/s",
      "/c",
      "%SystemRoot%\\System32\\wbem\\wmic.exe process where ProcessId=%PIONEER_RETENTION_OWNER_PID% get CreationDate /value",
    ]),
    runSpawn("wmic-pid-in-argv", wmic, wmicCreationDateArgs(pid)),
  );
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}

const report = {
  platform: process.platform,
  pid,
  production: {
    lookup: runChildProbe("production-lookup"),
    archiveSplit: runChildProbe("archive-split"),
  },
  candidates,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
