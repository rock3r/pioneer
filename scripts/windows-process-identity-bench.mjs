import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const cscript = path.win32.join(systemRoot, "System32", "cscript.exe");
const productionScript = path.join(repoRoot, "src", "review", "windows-process-start.js");
const productionArgs = ["//Nologo", "//B", "//E:JScript", "//T:5", productionScript];

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

function runChildProbe(probeName) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [scriptPath, `--probe=${probeName}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    shell: false,
    timeout: 60_000,
    windowsHide: true,
  });
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
  const first = runSpawn("production-cscript", cscript, productionArgs);
  const second = runSpawn("production-cscript-repeat", cscript, productionArgs);
  process.stdout.write(`${JSON.stringify({ probe: "production-lookup", first, second })}\n`);
  process.exit(first.status === 0 ? 0 : 1);
}

const powershell = path.win32.join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const cmd = path.win32.join(systemRoot, "System32", "cmd.exe");
const wmic = path.win32.join(systemRoot, "System32", "wbem", "wmic.exe");

const report = {
  platform: process.platform,
  pid,
  production: runChildProbe("production-lookup"),
  candidates: [
    runSpawn("cmd-echo-baseline", cmd, ["/d", "/s", "/c", "echo ok"]),
    runSpawn("powershell-get-process", powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[DateTimeOffset]::new((Get-Process -Id ([int]$env:PIONEER_RETENTION_OWNER_PID) -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()",
    ]),
    runSpawn("pwsh-get-process", "pwsh.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[DateTimeOffset]::new((Get-Process -Id ([int]$env:PIONEER_RETENTION_OWNER_PID) -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()",
    ]),
    runSpawn("cmd-wmic-env-pid", cmd, [
      "/d",
      "/s",
      "/c",
      "%SystemRoot%\\System32\\wbem\\wmic.exe process where ProcessId=%PIONEER_RETENTION_OWNER_PID% get CreationDate /value",
    ]),
    runSpawn("wmic-pid-in-argv", wmic, [
      "process",
      "where",
      `ProcessId=${pid}`,
      "get",
      "CreationDate",
      "/value",
    ]),
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
