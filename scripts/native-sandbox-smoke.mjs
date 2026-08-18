import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveLinuxBwrapPath } from "../dist/eval-run/linux-install.js";
import { startPublicEgressProxy } from "../dist/eval-run/public-egress-proxy.js";
import { runEvalCommand } from "../dist/eval-run/runner.js";
import { buildLinuxSandboxArgv, buildMacosSandboxArgv } from "../dist/sandbox/launcher.js";
import { startLinuxProxyBridge } from "../dist/sandbox/linux-proxy-bridge.js";
import { executableRuntimeRoot } from "../dist/sandbox/runtime-paths.js";

if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error(`Native smoke test is unsupported on ${process.platform}`);
}

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pioneer-native-smoke-")));
const source = path.join(root, "source");
const scratch = path.join(root, "scratch");
await Promise.all([
  mkdir(path.join(source, ".idea"), { recursive: true }),
  mkdir(path.join(source, ".vscode"), { recursive: true }),
  mkdir(scratch),
]);
await Promise.all([
  writeFile(path.join(source, ".idea", "marker.txt"), "idea-readable\n"),
  writeFile(path.join(source, ".vscode", "marker.txt"), "vscode-readable\n"),
  writeFile(path.join(source, "immutable.txt"), "unchanged\n"),
]);

const actor = String.raw`
const fs = require("fs");
const path = require("path");
const [source, scratch] = process.argv.slice(1);
const result = {
  idea: fs.readFileSync(path.join(source, ".idea", "marker.txt"), "utf8").trim(),
  vscode: fs.readFileSync(path.join(source, ".vscode", "marker.txt"), "utf8").trim(),
};
try { fs.writeFileSync(path.join(source, "immutable.txt"), "changed\n"); result.sourceWrite = "ALLOWED"; }
catch (error) { result.sourceWrite = error.code; }
fs.writeFileSync(path.join(scratch, "report.txt"), "scratch-ok\n");
try { fs.readFileSync("/etc/hosts"); result.outsideRead = "ALLOWED"; }
catch (error) { result.outsideRead = error.code; }
try { fs.statSync("/etc/hosts"); result.outsideMetadata = "ALLOWED"; }
catch (error) { result.outsideMetadata = error.code; }
process.stdout.write(JSON.stringify(result));
`;

const runtimeCandidates =
  process.platform === "darwin"
    ? ["/System", "/usr", "/bin", "/sbin", "/opt/homebrew", "/private/etc/ssl"]
    : ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl/certs"];
const nodeRuntime = await executableRuntimeRoot(process.execPath);
const nodeExecutable = await realpath(process.execPath);
const policy = {
  readOnlyPaths: [source, ...runtimeCandidates.filter(existsSync), nodeRuntime, nodeExecutable],
  writablePaths: [scratch],
  network: "none",
};
const command = [nodeExecutable, "-e", actor, source, scratch];
const linuxBwrap = process.platform === "linux" ? await resolveLinuxBwrapPath() : undefined;
if (process.platform === "linux" && linuxBwrap === undefined) {
  throw new Error("Linux sandbox smoke requires Bubblewrap");
}
const launch =
  process.platform === "darwin"
    ? buildMacosSandboxArgv(policy, command)
    : buildLinuxSandboxArgv(policy, command, linuxBwrap, undefined, nodeExecutable);

function capture(argv, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

try {
  const completed = spawnSync(launch.argv[0], launch.argv.slice(1), {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...launch.environment },
  });
  if (completed.status !== 0) {
    throw new Error(`sandbox actor failed (${completed.status}): ${completed.stderr}`);
  }
  const result = JSON.parse(completed.stdout);
  const sourceContent = await readFile(path.join(source, "immutable.txt"), "utf8");
  const scratchContent = await readFile(path.join(scratch, "report.txt"), "utf8");
  const passed =
    result.idea === "idea-readable" &&
    result.vscode === "vscode-readable" &&
    result.sourceWrite !== "ALLOWED" &&
    result.outsideRead !== "ALLOWED" &&
    result.outsideMetadata !== "ALLOWED" &&
    sourceContent === "unchanged\n" &&
    scratchContent === "scratch-ok\n";
  if (!passed) throw new Error(`filesystem probe failed: ${JSON.stringify(result)}`);

  const evalHome = path.join(root, "eval-pi-home");
  const evalPackageRoot = path.join(root, "unrelated-package");
  const evalBin = path.join(evalPackageRoot, "bin");
  const evalSiblingSecret = path.join(evalBin, "sibling-secret.txt");
  const evalPackageSecret = path.join(evalPackageRoot, "package-secret.txt");
  const evalPi = path.join(evalBin, "pi");
  const evalFinal = path.join(evalBin, "final");
  const evalMiddle = path.join(evalBin, "middle");
  const evalActor = path.join(evalBin, "eval-actor");
  const evalTimeoutActor = path.join(evalBin, "eval-timeout-actor");
  const evalContainmentActor = path.join(evalBin, "eval-containment-actor");
  const evalTimeoutRun = path.join(root, "timeout-run");
  const evalContainmentRun = path.join(root, "containment-run");
  const evalSetupInterruptionRun = path.join(root, "setup-interruption-run");
  await mkdir(evalHome);
  await mkdir(evalBin, { recursive: true });
  await mkdir(evalTimeoutRun);
  await mkdir(evalContainmentRun);
  await mkdir(evalSetupInterruptionRun);
  await writeFile(path.join(evalHome, "auth.json"), '{"marker":"eval-auth-secret"}\n');
  await writeFile(
    path.join(evalPackageRoot, "package.json"),
    JSON.stringify({ name: "unrelated-eval-actor" }),
  );
  await writeFile(evalSiblingSecret, "sibling-secret\n");
  await writeFile(evalPackageSecret, "package-secret\n");
  await writeFile(
    evalPi,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.84.2; exit 0; fi\nif [ ! -d "$PI_CODING_AGENT_DIR" ]; then echo "No models available."; exit 0; fi\nprintf \'provider  model  context  max-out  thinking  images\\nsmoke  actor  1K  1K  no  no\\n\'\n',
    { mode: 0o755 },
  );
  const nestedInterpreter =
    'const { spawnSync } = require("node:child_process");\nconst [script, ...args] = process.argv.slice(2);\nconst child = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });\nprocess.exit(child.status ?? 1);\n';
  await writeFile(evalFinal, `#!${nodeExecutable}\n${nestedInterpreter}`, { mode: 0o755 });
  await writeFile(evalMiddle, `#!/usr/bin/env final\n${nestedInterpreter}`, { mode: 0o755 });
  await writeFile(
    evalActor,
    `#!/usr/bin/env middle\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst probes = ${JSON.stringify([evalSiblingSecret, evalPackageSecret])};\nconst leaked = probes.filter((probe) => { try { fs.readFileSync(probe); return true; } catch { return false; } });\nif (leaked.length > 0) { process.stdout.write("implicit-read-allowed:" + leaked.join(",") + "\\n"); process.exit(1); }\nconst piAgentDir = process.env.PI_CODING_AGENT_DIR;\nif (!piAgentDir || !path.relative(process.cwd(), piAgentDir).startsWith("..")) { process.stdout.write("pi-home-not-externalized\\n"); process.exit(1); }\nfor (const name of ["auth.json.lock", "settings.json.lock"]) {\n  try {\n    const lockDir = path.join(piAgentDir, name);\n    fs.mkdirSync(lockDir);\n    fs.writeFileSync(path.join(lockDir, "owner"), "eval-lock");\n  } catch (error) {\n    process.stdout.write("pi-lock-failed:" + name + ":" + (error.code || error.message) + "\\n");\n    process.exit(1);\n  }\n}\nfs.writeFileSync(path.join(process.cwd(), "pi-home-path.txt"), path.dirname(piAgentDir));\nif (fs.existsSync(path.join(process.cwd(), ".isolation"))) { process.stdout.write("controller-artifacts-visible\\n"); process.exit(1); }\nif (process.argv.at(-1) !== "nested-argument") { process.stdout.write("nested-argument-lost\\n"); process.exit(1); }\nprocess.stdout.write("eval-production-path-ok\\n"); process.stderr.write("eval-production-path-err\\n");\n`,
    { mode: 0o755 },
  );
  await writeFile(
    evalTimeoutActor,
    `#!${nodeExecutable}\nconst { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "inherit" }); process.stdout.write("timeout-before\\n"); process.stderr.write("timeout-error-before\\n"); setInterval(() => {}, 10000);\n`,
    { mode: 0o755 },
  );
  await writeFile(
    evalContainmentActor,
    `#!${nodeExecutable}\nconst { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "inherit" }); process.stdout.write("containment-before\\n"); process.exit(0);\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${evalBin}${path.delimiter}${previousPath ?? ""}`;
  const evalLogs = path.join(root, "eval-logs");
  await mkdir(evalLogs);
  let evalLogIndex = 0;
  const nextEvalWorkLog = () => path.join(evalLogs, `eval-${evalLogIndex++}.jsonl`);
  try {
    const evalResult = await runEvalCommand(
      {
        runDir: scratch,
        command: ["eval-actor", "nested-argument"],
        piHomeSource: evalHome,
      },
      { timeoutMs: 5_000, workLogPath: nextEvalWorkLog() },
    );
    if (
      evalResult.exitCode !== 0 ||
      evalResult.stdout !== "eval-production-path-ok\n" ||
      evalResult.stderr !== "eval-production-path-err\n"
    ) {
      throw new Error(`production eval path failed: ${JSON.stringify(evalResult)}`);
    }
    if (existsSync(path.join(scratch, ".isolation"))) {
      throw new Error("production eval path retained controller artifacts in the actor run");
    }
    const copiedPiHome = (await readFile(path.join(scratch, "pi-home-path.txt"), "utf8")).trim();
    if (existsSync(copiedPiHome)) {
      throw new Error("production eval path retained its copied Pi home after actor completion");
    }
    if (
      (await readFile(path.join(evalHome, "auth.json"), "utf8")) !==
      '{"marker":"eval-auth-secret"}\n'
    ) {
      throw new Error("production eval path modified the source Pi credentials");
    }
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = scratch;
    let defaultPiHomeOverlapRejected = false;
    try {
      await runEvalCommand(
        { runDir: scratch, command: ["eval-actor", "nested-argument"] },
        { timeoutMs: 5_000, workLogPath: nextEvalWorkLog() },
      );
    } catch (error) {
      defaultPiHomeOverlapRejected =
        error instanceof Error && /Pi home.*overlap/i.test(error.message);
    } finally {
      if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    if (!defaultPiHomeOverlapRejected) {
      throw new Error("production eval path accepted a default Pi home overlapping the actor run");
    }
    const missingPiHome = path.join(root, "missing-pi-home");
    process.env.PI_CODING_AGENT_DIR = missingPiHome;
    let missingDefaultDiagnosticPreserved = false;
    let missingDefaultError = "no error";
    try {
      await runEvalCommand(
        { runDir: evalSetupInterruptionRun, command: ["eval-actor", "nested-argument"] },
        { timeoutMs: 5_000, workLogPath: nextEvalWorkLog() },
      );
    } catch (error) {
      missingDefaultError = error instanceof Error ? error.message : String(error);
      missingDefaultDiagnosticPreserved =
        error instanceof Error &&
        (error.message.includes("[PI_NO_MODELS]") ||
          error.message.includes("[PI_CONFIG_HIDDEN_BY_SANDBOX]"));
    } finally {
      if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    if (!missingDefaultDiagnosticPreserved) {
      throw new Error(
        `production eval path lost the missing-default Pi readiness diagnostic: ${missingDefaultError}`,
      );
    }
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const environmentControlledTempResult = await runEvalCommand(
        {
          runDir: evalSetupInterruptionRun,
          command: ["eval-actor", "nested-argument"],
          piHomeSource: evalHome,
        },
        { timeoutMs: 5_000, workLogPath: nextEvalWorkLog() },
      );
      if (environmentControlledTempResult.exitCode !== 0) {
        throw new Error(
          `production eval control temp followed TMPDIR: ${JSON.stringify(environmentControlledTempResult)}`,
        );
      }
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
    const setupInterruptionPromise = runEvalCommand(
      {
        runDir: evalSetupInterruptionRun,
        command: ["eval-actor", "nested-argument"],
        piHomeSource: evalHome,
      },
      { timeoutMs: 5_000, workLogPath: nextEvalWorkLog() },
    );
    process.emit("SIGTERM");
    const setupInterruptionResult = await setupInterruptionPromise;
    if (
      setupInterruptionResult.exitCode === 0 ||
      setupInterruptionResult.interrupted !== "SIGTERM" ||
      !setupInterruptionResult.stderr.includes("[EVAL_INTERRUPTED]") ||
      existsSync(path.join(evalSetupInterruptionRun, ".isolation"))
    ) {
      throw new Error(
        `production eval setup interruption failed: ${JSON.stringify(setupInterruptionResult)}`,
      );
    }
    const timeoutStarted = performance.now();
    const timeoutResult = await runEvalCommand(
      {
        runDir: evalTimeoutRun,
        command: ["eval-timeout-actor"],
        piHomeSource: evalHome,
      },
      { timeoutMs: 500, workLogPath: nextEvalWorkLog() },
    );
    const timeoutElapsed = performance.now() - timeoutStarted;
    if (
      timeoutResult.exitCode === 0 ||
      timeoutResult.timedOut !== true ||
      !timeoutResult.stdout.includes("timeout-before") ||
      !timeoutResult.stderr.includes("timeout-error-before") ||
      !timeoutResult.stderr.includes("[EVAL_TIMEOUT]") ||
      timeoutElapsed >= 3_000
    ) {
      throw new Error(
        `production eval timeout path failed (${Math.round(timeoutElapsed)}ms): ${JSON.stringify(timeoutResult)}`,
      );
    }
    const containmentStarted = performance.now();
    const containmentResult = await runEvalCommand(
      {
        runDir: evalContainmentRun,
        command: ["eval-containment-actor"],
        piHomeSource: evalHome,
      },
      { timeoutMs: 5_000, workLogPath: nextEvalWorkLog() },
    );
    const containmentElapsed = performance.now() - containmentStarted;
    const linuxContainmentHandled =
      process.platform === "linux" &&
      containmentResult.exitCode === 0 &&
      containmentResult.containmentFailure !== true &&
      containmentResult.stderr === "";
    if (
      (!linuxContainmentHandled && containmentResult.exitCode === 0) ||
      (!linuxContainmentHandled && containmentResult.containmentFailure !== true) ||
      !containmentResult.stdout.includes("containment-before") ||
      (!linuxContainmentHandled &&
        !containmentResult.stderr.includes("[EVAL_PROCESS_CONTAINMENT_FAILED]")) ||
      containmentElapsed >= 3_000
    ) {
      throw new Error(
        `production eval containment path failed (${Math.round(containmentElapsed)}ms): ${JSON.stringify(containmentResult)}`,
      );
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  if (process.platform === "darwin") {
    const forkActor = `
const { spawn } = require("node:child_process");
const finish = (error) => {
  process.stdout.write(error && error.code === "EPERM" ? "fork-denied" : String(error));
  process.exitCode = error && error.code === "EPERM" ? 0 : 1;
};
try {
  const child = spawn("/usr/bin/true");
  child.once("error", finish);
  child.once("spawn", () => { process.exitCode = 2; });
} catch (error) {
  finish(error);
}
`;
    const noForkLaunch = buildMacosSandboxArgv({ ...policy, allowProcessFork: false }, [
      nodeExecutable,
      "-e",
      forkActor,
    ]);
    const noForkCompleted = spawnSync(noForkLaunch.argv[0], noForkLaunch.argv.slice(1), {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...noForkLaunch.environment },
    });
    if (noForkCompleted.status !== 0 || noForkCompleted.stdout !== "fork-denied") {
      throw new Error(
        `process containment probe failed (${noForkCompleted.status}): ${noForkCompleted.stdout}${noForkCompleted.stderr}`,
      );
    }
  }

  const localServer = net.createServer((socket) => socket.end("unexpected"));
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const localAddress = localServer.address();
  if (localAddress === null || typeof localAddress === "string") throw new Error("no local port");
  const proxy = await startPublicEgressProxy("native-smoke-token".padEnd(32, "x"));
  const bridge =
    process.platform === "linux"
      ? await startLinuxProxyBridge(proxy.url, path.join(root, "proxy.sock"))
      : undefined;
  try {
    const networkActor = `
const { spawnSync } = require("child_process");
const net = require("net");
const port = Number(process.argv[1]);
const publicResult = spawnSync("/usr/bin/curl", ["-fsS", "--max-time", "15", "https://example.com/"], { env: process.env });
const result = { publicStatus: publicResult.status, publicStderr: publicResult.stderr.toString("utf8").slice(-500), directConnected: false };
const socket = net.connect({ host: "127.0.0.1", port });
const timer = setTimeout(() => { socket.destroy(); process.stdout.write(JSON.stringify(result)); }, 1500);
socket.once("connect", () => { result.directConnected = true; clearTimeout(timer); socket.destroy(); process.stdout.write(JSON.stringify(result)); });
socket.once("error", () => { clearTimeout(timer); process.stdout.write(JSON.stringify(result)); });
`;
    const networkPolicy = {
      ...policy,
      network: "proxy",
      proxyUrl: proxy.url,
    };
    const networkCommand = [nodeExecutable, "-e", networkActor, String(localAddress.port)];
    const networkLaunch =
      process.platform === "darwin"
        ? buildMacosSandboxArgv(networkPolicy, networkCommand)
        : buildLinuxSandboxArgv(
            networkPolicy,
            networkCommand,
            linuxBwrap,
            bridge.socketPath,
            nodeExecutable,
          );
    const networkCompleted = await capture(networkLaunch.argv, {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.platform === "darwin"
        ? {
            OPENSSL_CONF: "/private/etc/ssl/openssl.cnf",
            SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
          }
        : {}),
      ...networkLaunch.environment,
    });
    if (networkCompleted.status !== 0) {
      throw new Error(
        `network actor failed (${networkCompleted.status}): ${networkCompleted.stderr}`,
      );
    }
    const networkResult = JSON.parse(networkCompleted.stdout);
    const networkPassed =
      networkResult.publicStatus === 0 && networkResult.directConnected === false;
    process.stdout.write(
      `${JSON.stringify({ platform: process.platform, passed: networkPassed, ...result, ...networkResult })}\n`,
    );
    if (!networkPassed) process.exitCode = 1;
  } finally {
    await bridge?.close();
    await proxy.close();
    await new Promise((resolve) => localServer.close(() => resolve()));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
