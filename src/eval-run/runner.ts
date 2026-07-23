import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { defaultPiAgentDir, prepareIsolatedPiHome } from "../pi-home.js";
import { assertPiReady } from "../pi-readiness.js";
import { optimizePiStartupCommand, requestedPiModel } from "../pi-startup.js";
import {
  buildLinuxSandboxArgv,
  buildMacosSandboxArgv,
  type SandboxPolicy,
} from "../sandbox/launcher.js";
import { type LinuxProxyBridge, startLinuxProxyBridge } from "../sandbox/linux-proxy-bridge.js";
import { executableRuntimeRoot } from "../sandbox/runtime-paths.js";
import { buildEvalSandboxConfig, type EvalRunSpec, validateEvalRunSpec } from "./isolation.js";
import { resolveLinuxBwrapPath } from "./linux-install.js";
import { macosRuntimeReadPaths } from "./macos-runtime.js";
import { assertStrictEvalReady } from "./platform-readiness.js";
import { startPublicEgressProxy } from "./public-egress-proxy.js";

export interface EvalRunResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunEvalOptions {
  readonly deniedReadProbePaths?: readonly string[];
  readonly timeoutMs?: number;
}

const OUTSIDE_SENTINEL_CONTENT = "outside-root sentinel";

const PROBE_SOURCE = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
const [specPath] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, "utf8"));
for (const deniedPath of spec.deniedReadPaths) {
  try {
    await readFile(deniedPath);
    throw new Error("READ_ALLOWED:" + deniedPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("READ_ALLOWED:")) throw error;
  }
}
try {
  await writeFile(spec.deniedWritePath, "escape");
} catch {
  // Expected on platforms that reject the syscall; Linux may write only to a disposable tmpfs mask.
}
if (process.env.PIONEER_HOST_SECRET !== undefined) throw new Error("HOST_ENV_LEAKED");
await new Promise((resolve, reject) => {
  const socket = net.connect({ host: "127.0.0.1", port: spec.localPort });
  const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("LOCAL_NETWORK_ALLOWED")); });
  socket.once("error", () => { clearTimeout(timer); resolve(); });
});
process.stdout.write("isolation-ok\n");
`;

const LAUNCHER_SOURCE = `
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const [specPath] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, "utf8"));
const child = spawn(spec.command[0], spec.command.slice(1), {
  cwd: spec.cwd, env: { ...process.env, ...spec.environment }, shell: false, stdio: "inherit",
});
child.once("error", (error) => { console.error(error.message); process.exitCode = 127; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;

async function existingRuntimePaths(): Promise<string[]> {
  const candidates =
    process.platform === "darwin"
      ? ["/System", "/usr", "/bin", "/sbin", "/Library/Apple/System", "/private/etc/ssl"]
      : process.platform === "linux"
        ? [
            "/usr",
            "/bin",
            "/lib",
            "/lib64",
            "/etc/ssl/certs",
            "/etc/resolv.conf",
            "/etc/hosts",
            "/etc/nsswitch.conf",
            "/etc/passwd",
            "/etc/group",
          ]
        : [
            path.win32.join(process.env.SystemRoot ?? "C:\\Windows"),
            process.env.ProgramFiles ?? "C:\\Program Files",
            process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
          ];
  const result: string[] = [];
  const nodeRuntime = await executableRuntimeRoot(process.execPath);
  for (const candidate of [...candidates, nodeRuntime]) {
    try {
      await access(candidate, constants.R_OK);
      result.push(candidate);
    } catch {
      // Optional runtime path is absent on this host.
    }
  }
  return result;
}

function sanitizedBrokerEnvironment(runtimeEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PATHEXT", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "ComSpec"];
  const sanitized = Object.fromEntries(
    allowed.flatMap((name) => {
      const value = runtimeEnvironment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  if (process.platform === "darwin") {
    sanitized.SSL_CERT_FILE = "/private/etc/ssl/cert.pem";
    sanitized.OPENSSL_CONF = "/private/etc/ssl/openssl.cnf";
  }
  return sanitized;
}

async function capture(
  argv: readonly [string, ...string[]],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<EvalRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function sandboxAndCapture(
  policy: SandboxPolicy,
  command: readonly [string, ...string[]],
  runDir: string,
  timeoutMs: number,
  bwrapPath?: string,
  proxySocketPath?: string,
): Promise<EvalRunResult> {
  const launch =
    process.platform === "darwin"
      ? buildMacosSandboxArgv(policy, command)
      : buildLinuxSandboxArgv(policy, command, bwrapPath ?? "", proxySocketPath);
  return await capture(
    launch.argv,
    runDir,
    { ...sanitizedBrokerEnvironment(process.env), ...launch.environment },
    timeoutMs,
  );
}

async function listenForLanProbe(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("LAN isolation probe could not bind");
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function runEvalCommand(
  spec: EvalRunSpec,
  options: RunEvalOptions = {},
): Promise<EvalRunResult> {
  const requestedModel = requestedPiModel(spec.command);
  const piHomeSource = spec.piHomeSource ?? defaultPiAgentDir();
  const readinessOptions = {
    environment: { ...process.env, PI_CODING_AGENT_DIR: piHomeSource },
    ...(requestedModel === undefined ? {} : { requestedModel }),
  };
  await assertPiReady(readinessOptions);
  await assertStrictEvalReady();
  const validated = await validateEvalRunSpec({
    ...spec,
    runtimeReadPaths: [...(spec.runtimeReadPaths ?? []), ...(await existingRuntimePaths())],
  });
  const isolationDir = path.join(validated.runDir, ".isolation");
  await mkdir(isolationDir);
  const piHome = await prepareIsolatedPiHome({
    sourceDir: validated.piHomeSource ?? piHomeSource,
    destination: path.join(isolationDir, "pi-home"),
    mode: "eval",
  });
  const probeScript = path.join(isolationDir, "probe.mjs");
  const probeSpec = path.join(isolationDir, "probe.json");
  const launcherScript = path.join(isolationDir, "launch.mjs");
  const launchSpec = path.join(isolationDir, "launch.json");
  const deniedWritePath = path.join(
    path.dirname(validated.runDir),
    `.escape-${randomBytes(8).toString("hex")}`,
  );
  await writeFile(deniedWritePath, OUTSIDE_SENTINEL_CONTENT, { flag: "wx", mode: 0o600 });
  await writeFile(probeScript, PROBE_SOURCE, { flag: "wx", mode: 0o500 });
  await writeFile(launcherScript, LAUNCHER_SOURCE, { flag: "wx", mode: 0o500 });
  const optimizedPi = optimizePiStartupCommand(validated.command, { disableSkills: true });
  await writeFile(
    launchSpec,
    JSON.stringify({
      command: optimizedPi.command,
      cwd: validated.runDir,
      environment: {
        ...optimizedPi.environment,
        ...piHome.environment,
        HOME: piHome.homeDir,
        TMPDIR: piHome.tmpDir,
      },
    }),
    { flag: "wx", mode: 0o400 },
  );

  const lanProbe = await listenForLanProbe();
  await writeFile(
    probeSpec,
    JSON.stringify({
      deniedReadPaths: [deniedWritePath, ...(options.deniedReadProbePaths ?? [])],
      deniedWritePath,
      localPort: lanProbe.port,
    }),
    { flag: "wx", mode: 0o400 },
  );

  const proxy = await startPublicEgressProxy(randomBytes(32).toString("hex"));
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;
  try {
    const linuxBwrapPath = process.platform === "linux" ? await resolveLinuxBwrapPath() : undefined;
    if (process.platform === "linux" && linuxBwrapPath === undefined) {
      throw new Error("Linux sandboxing requires Bubblewrap (`bwrap`) to be installed");
    }
    if (process.platform === "linux") {
      bridgeRoot = await mkdtemp("/tmp/pir-bridge-");
      bridge = await startLinuxProxyBridge(proxy.url, path.join(bridgeRoot, "proxy.sock"));
    }
    const config = buildEvalSandboxConfig({
      platform: process.platform as "darwin" | "linux" | "win32",
      runDir: validated.runDir,
      runtimeReadPaths: [
        ...validated.runtimeReadPaths,
        ...(await macosRuntimeReadPaths(process.execPath)),
      ],
      parentProxyUrl: proxy.url,
    });
    process.env.PIONEER_HOST_SECRET = randomBytes(32).toString("hex");
    const timeoutMs = options.timeoutMs ?? 300_000;
    const probeResult = await sandboxAndCapture(
      config,
      [process.execPath, probeScript, probeSpec],
      validated.runDir,
      Math.min(timeoutMs, 30_000),
      linuxBwrapPath,
      bridge?.socketPath,
    );
    if (probeResult.exitCode !== 0 || probeResult.stdout.trim() !== "isolation-ok") {
      throw new Error(
        `Eval isolation probe failed closed: ${probeResult.stderr || probeResult.stdout}`,
      );
    }
    if ((await readFile(deniedWritePath, "utf8")) !== OUTSIDE_SENTINEL_CONTENT) {
      throw new Error("Eval isolation probe failed closed: host sentinel was modified");
    }
    return await sandboxAndCapture(
      config,
      [process.execPath, launcherScript, launchSpec],
      validated.runDir,
      timeoutMs,
      linuxBwrapPath,
      bridge?.socketPath,
    );
  } finally {
    delete process.env.PIONEER_HOST_SECRET;
    await bridge?.close();
    if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
    await proxy.close();
    await lanProbe.close();
    await unlink(deniedWritePath).catch(() => undefined);
  }
}
