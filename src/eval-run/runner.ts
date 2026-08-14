import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { defaultPiAgentDir, prepareIsolatedPiHome } from "../pi-home.js";
import { assertPiReady } from "../pi-readiness.js";
import { isPiExecutable, optimizePiStartupCommand, requestedPiModel } from "../pi-startup.js";
import {
  buildLinuxSandboxArgv,
  buildMacosSandboxArgv,
  type SandboxPolicy,
} from "../sandbox/launcher.js";
import { type LinuxProxyBridge, startLinuxProxyBridge } from "../sandbox/linux-proxy-bridge.js";
import { assertNativeSandboxReady } from "../sandbox/platform-readiness.js";
import { executableRuntimeRoot } from "../sandbox/runtime-paths.js";
import {
  buildEvalExecutableReadPaths,
  buildEvalSandboxConfig,
  type EvalRunSpec,
  findValidatedPiPackageRoot,
  isTrustedPiInstallation,
  pathsOverlap,
  type ResolvedEvalExecutable,
  resolveEvalExecutable,
  validateEvalRunSpec,
} from "./isolation.js";
import { resolveLinuxBwrapPath } from "./linux-install.js";
import { macosRuntimeReadPaths } from "./macos-runtime.js";
import { startPublicEgressProxy } from "./public-egress-proxy.js";

export interface EvalRunResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly containmentFailure?: boolean;
  readonly interrupted?: NodeJS.Signals;
  readonly warning?: string;
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

const EVAL_PIPE_CLOSE_GRACE_MS = 400;
const EVAL_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const EVAL_MAX_STDERR_BYTES = 64 * 1024;

class EvalSetupInterrupted extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Eval setup interrupted by ${signal}`);
    this.signal = signal;
  }
}

function interruptedEvalResult(signal: NodeJS.Signals, completed?: EvalRunResult): EvalRunResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: completed?.stdout ?? "",
    stderr: stderrWithDiagnostic(
      completed?.stderr ?? "",
      `[EVAL_INTERRUPTED] Eval actor interrupted by ${signal}`,
    ),
    interrupted: signal,
    ...(completed?.warning === undefined ? {} : { warning: completed.warning }),
  };
}

interface EvalInterruptionState {
  readonly abortSignal: AbortSignal;
  signal?: NodeJS.Signals;
}

function throwIfEvalInterrupted(interruption: EvalInterruptionState): void {
  if (interruption.signal !== undefined) {
    throw new EvalSetupInterrupted(interruption.signal);
  }
}

function stderrWithDiagnostic(stderr: string, diagnostic: string): string {
  const diagnosticSuffix = `${diagnostic}\n`;
  const prefixBudget = Math.max(0, EVAL_MAX_STDERR_BYTES - Buffer.byteLength(diagnosticSuffix) - 1);
  const prefix = Buffer.from(stderr).subarray(0, prefixBudget).toString("utf8");
  const separator = prefix.length === 0 || prefix.endsWith("\n") ? "" : "\n";
  return Buffer.from(`${prefix}${separator}${diagnosticSuffix}`)
    .subarray(0, EVAL_MAX_STDERR_BYTES)
    .toString("utf8");
}

function terminateEvalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited; signal the direct child below.
    }
  }
  child.kill(signal);
}

function decodeBoundedUtf8(chunks: readonly Buffer[], limit: number): string {
  if (limit <= 0) return "";
  const decoded = Buffer.concat(chunks).subarray(0, limit).toString("utf8");
  const normalized = Buffer.from(decoded, "utf8");
  if (normalized.length <= limit) return decoded;
  // Truncating a valid UTF-8 buffer can leave at most one partial code point;
  // dropping three bytes before decoding prevents replacement expansion from
  // exceeding the byte cap without an unbounded retry loop.
  return normalized.subarray(0, Math.max(0, limit - 3)).toString("utf8");
}

export async function captureEvalProcess(
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
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      child.kill();
      reject(new Error("[EVAL_CAPTURE_FAILED] Eval process pipes were unavailable"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let childExited = false;
    let timedOut = false;
    let containmentFailure = false;
    let outputLimit = false;
    let interrupted: NodeJS.Signals | undefined;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let onSigint: (() => void) | undefined;
    let onSigterm: (() => void) | undefined;

    const output = (): { readonly stdout: string; readonly stderr: string } => ({
      stdout: decodeBoundedUtf8(stdout, EVAL_MAX_STDOUT_BYTES),
      stderr: decodeBoundedUtf8(stderr, EVAL_MAX_STDERR_BYTES),
    });
    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (onSigint !== undefined) process.off("SIGINT", onSigint);
      if (onSigterm !== undefined) process.off("SIGTERM", onSigterm);
    };
    const settle = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const captured = output();
      const diagnostic = timedOut
        ? `[EVAL_TIMEOUT] Eval actor timed out after ${timeoutMs}ms`
        : containmentFailure
          ? "[EVAL_PROCESS_CONTAINMENT_FAILED] Pioneer could not prove the eval actor process tree stopped"
          : outputLimit
            ? `[EVAL_OUTPUT_LIMIT] Eval actor output exceeded the ${EVAL_MAX_STDOUT_BYTES}-byte stdout or ${EVAL_MAX_STDERR_BYTES}-byte stderr limit`
            : interrupted === undefined
              ? undefined
              : `[EVAL_INTERRUPTED] Eval actor interrupted by ${interrupted}`;
      resolve({
        exitCode:
          diagnostic === undefined && (exitCode ?? 1) === 0
            ? 0
            : diagnostic === undefined
              ? (exitCode ?? 1)
              : 1,
        signal,
        stdout: captured.stdout,
        stderr:
          diagnostic === undefined
            ? captured.stderr
            : stderrWithDiagnostic(captured.stderr, diagnostic),
        ...(timedOut ? { timedOut: true } : {}),
        ...(containmentFailure ? { containmentFailure: true } : {}),
        ...(interrupted === undefined ? {} : { interrupted }),
      });
    };
    const containmentDeadline = (): void => {
      if (settled) return;
      containmentFailure = true;
      terminateEvalProcessTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle();
    };
    const startGrace = (): void => {
      if (graceTimer !== undefined || settled) return;
      graceTimer = setTimeout(containmentDeadline, EVAL_PIPE_CLOSE_GRACE_MS);
    };
    const terminate = (kind: "timeout" | NodeJS.Signals): void => {
      if (settled || childExited) return;
      if (kind === "timeout") timedOut = true;
      else interrupted = kind;
      terminateEvalProcessTree(child, kind === "timeout" ? "SIGKILL" : kind);
      startGrace();
    };

    const appendOutput = (
      chunks: Buffer[],
      chunk: Buffer,
      retainedBytes: number,
      limit: number,
    ): number => {
      const remaining = limit - retainedBytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (retainedBytes + chunk.length > limit && !outputLimit) {
        outputLimit = true;
        terminateEvalProcessTree(child, "SIGKILL");
        startGrace();
      }
      return retainedBytes + chunk.length;
    };
    let stdoutBytes = 0;
    let stderrBytes = 0;

    childStdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendOutput(stdout, chunk, stdoutBytes, EVAL_MAX_STDOUT_BYTES);
    });
    childStderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendOutput(stderr, chunk, stderrBytes, EVAL_MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      if (settled) return;
      cleanup();
      settled = true;
      reject(
        new Error(
          `[EVAL_SPAWN_FAILED] Pioneer could not start the eval sandbox process: ${error.message.replaceAll(/\s+/g, " ").slice(0, 300)}`,
        ),
      );
    });
    child.once("exit", (code, childSignal) => {
      childExited = true;
      exitCode = code;
      signal = childSignal;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      graceTimer = undefined;
      startGrace();
      if (childSignal !== null || code !== null) {
        // `close` below remains authoritative because descendants may retain the pipes.
      }
    });
    child.once("close", (code, childSignal) => {
      childExited = true;
      exitCode = code;
      signal = childSignal;
      if (!timedOut && !containmentFailure && interrupted === undefined) settle();
      else settle();
    });
    onSigint = () => terminate("SIGINT");
    onSigterm = () => terminate("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    void childExited;
  });
}

async function sandboxAndCapture(
  policy: SandboxPolicy,
  command: readonly [string, ...string[]],
  runDir: string,
  timeoutMs: number,
  bwrapPath?: string,
  proxySocketPath?: string,
  runtimeExecutable = process.execPath,
): Promise<EvalRunResult> {
  const launch =
    process.platform === "darwin"
      ? buildMacosSandboxArgv(policy, command)
      : buildLinuxSandboxArgv(policy, command, bwrapPath ?? "", proxySocketPath, runtimeExecutable);
  return await captureEvalProcess(
    launch.argv,
    runDir,
    { ...sanitizedBrokerEnvironment(process.env), ...launch.environment },
    timeoutMs,
  );
}

export function buildEvalLaunchCommand(
  resolved: Pick<ResolvedEvalExecutable, "command" | "commandPath" | "readPaths">,
  actorArguments: readonly string[],
): [string, ...string[]] {
  return [
    ...(resolved.command ?? [resolved.readPaths[0] ?? resolved.commandPath]),
    ...actorArguments,
  ] as [string, ...string[]];
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
  const abortController = new AbortController();
  const interruption: EvalInterruptionState = { abortSignal: abortController.signal };
  const onSigint = (): void => {
    interruption.signal ??= "SIGINT";
    abortController.abort();
  };
  const onSigterm = (): void => {
    interruption.signal ??= "SIGTERM";
    abortController.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await runEvalCommandWithInterruption(spec, options, interruption);
  } catch (error) {
    if (interruption.signal !== undefined) return interruptedEvalResult(interruption.signal);
    if (error instanceof EvalSetupInterrupted) return interruptedEvalResult(error.signal);
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function runEvalCommandWithInterruption(
  spec: EvalRunSpec,
  options: RunEvalOptions,
  interruption: EvalInterruptionState,
): Promise<EvalRunResult> {
  throwIfEvalInterrupted(interruption);
  const requestedModel = requestedPiModel(spec.command);
  const piHomeSource = spec.piHomeSource ?? defaultPiAgentDir();
  const initialReadinessOptions = {
    environment: { ...process.env, PI_CODING_AGENT_DIR: piHomeSource },
    ...(requestedModel === undefined ? {} : { requestedModel }),
    signal: interruption.abortSignal,
  };
  const sandboxRuntimeExecutable = await realpath(process.execPath);
  throwIfEvalInterrupted(interruption);
  await assertNativeSandboxReady();
  throwIfEvalInterrupted(interruption);
  let readiness =
    spec.piHomeSource === undefined ? await assertPiReady(initialReadinessOptions) : undefined;
  throwIfEvalInterrupted(interruption);
  const validated = await validateEvalRunSpec({
    ...spec,
    piHomeSource,
    runtimeReadPaths: [...(spec.runtimeReadPaths ?? []), ...(await existingRuntimePaths())],
  });
  throwIfEvalInterrupted(interruption);
  const validatedPiHomeSource = validated.piHomeSource;
  if (validatedPiHomeSource === undefined) {
    throw new Error("Validated eval Pi home source is unavailable");
  }
  const optimizedPi = optimizePiStartupCommand(validated.command, {
    disableExtensions: true,
    disableSkills: true,
  });
  const resolvedExecutable = await resolveEvalExecutable(
    optimizedPi.command[0],
    validated.runDir,
    sanitizedBrokerEnvironment(process.env).PATH ?? "",
  );
  throwIfEvalInterrupted(interruption);
  const sandboxCommand = buildEvalLaunchCommand(resolvedExecutable, optimizedPi.command.slice(1));
  const piActor = isPiExecutable(spec.command[0]);
  const controllerPiInstallation = piActor
    ? await (async () => {
        try {
          const controllerPi = await resolveEvalExecutable(
            "pi",
            validated.runDir,
            sanitizedBrokerEnvironment(process.env).PATH ?? "",
          );
          return await findValidatedPiPackageRoot(controllerPi.commandPath);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const piInstallation = piActor
    ? await findValidatedPiPackageRoot(resolvedExecutable.commandPath, validated.runDir)
    : undefined;
  throwIfEvalInterrupted(interruption);
  if (piActor && !isTrustedPiInstallation(piInstallation, controllerPiInstallation)) {
    throw new Error("Pi eval actor is not a validated Pi installation");
  }
  const readinessOptions = {
    environment: { ...process.env, PI_CODING_AGENT_DIR: validatedPiHomeSource },
    ...(requestedModel === undefined ? {} : { requestedModel }),
    signal: interruption.abortSignal,
  };
  readiness ??= await assertPiReady(readinessOptions);
  throwIfEvalInterrupted(interruption);
  const controllerTempRoot = await realpath(
    process.platform === "darwin" ? "/private/tmp" : "/tmp",
  );
  throwIfEvalInterrupted(interruption);
  const createdIsolationDir = await mkdtemp(path.join(controllerTempRoot, "pioneer-eval-control-"));
  let isolationDir: string;
  try {
    isolationDir = await realpath(createdIsolationDir);
  } catch (error) {
    await rm(createdIsolationDir, { recursive: true, force: true });
    throw error;
  }
  const throwIfSetupInterrupted = (): void => {
    throwIfEvalInterrupted(interruption);
  };
  const actorScratchDir = path.join(isolationDir, "actor-scratch");
  const probeScript = path.join(isolationDir, "probe.mjs");
  const probeSpec = path.join(isolationDir, "probe.json");
  const launcherScript = path.join(isolationDir, "launch.mjs");
  const launchSpec = path.join(isolationDir, "launch.json");
  const deniedWritePath = path.join(
    path.dirname(validated.runDir),
    `.escape-${randomBytes(8).toString("hex")}`,
  );
  let lanProbe: Awaited<ReturnType<typeof listenForLanProbe>> | undefined;
  let proxy: Awaited<ReturnType<typeof startPublicEgressProxy>> | undefined;
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;
  let completedResult: EvalRunResult | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const actorGrantPaths = [
      validated.runDir,
      ...validated.runtimeReadPaths,
      sandboxRuntimeExecutable,
      ...(await macosRuntimeReadPaths(process.execPath)),
      ...buildEvalExecutableReadPaths(resolvedExecutable, piInstallation),
    ];
    if (actorGrantPaths.some((grantPath) => pathsOverlap(isolationDir, grantPath))) {
      throw new Error("Eval controller directory must not overlap actor grants");
    }
    throwIfSetupInterrupted();
    await mkdir(actorScratchDir, { mode: 0o700 });
    throwIfSetupInterrupted();
    const piHome = await prepareIsolatedPiHome({
      sourceDir: validatedPiHomeSource,
      destination: path.join(actorScratchDir, "pi-home"),
      mode: "eval",
      checkAborted: throwIfSetupInterrupted,
    });
    throwIfSetupInterrupted();
    await writeFile(deniedWritePath, OUTSIDE_SENTINEL_CONTENT, { flag: "wx", mode: 0o600 });
    await writeFile(probeScript, PROBE_SOURCE, { flag: "wx", mode: 0o500 });
    await writeFile(launcherScript, LAUNCHER_SOURCE, { flag: "wx", mode: 0o500 });
    await writeFile(
      launchSpec,
      JSON.stringify({
        command: sandboxCommand,
        cwd: validated.runDir,
        environment: { ...optimizedPi.environment, ...piHome.environment },
      }),
      { flag: "wx", mode: 0o400 },
    );
    throwIfSetupInterrupted();

    lanProbe = await listenForLanProbe();
    throwIfSetupInterrupted();
    await writeFile(
      probeSpec,
      JSON.stringify({
        deniedReadPaths: [deniedWritePath, ...(options.deniedReadProbePaths ?? [])],
        deniedWritePath,
        localPort: lanProbe.port,
      }),
      { flag: "wx", mode: 0o400 },
    );
    throwIfSetupInterrupted();

    proxy = await startPublicEgressProxy(randomBytes(32).toString("hex"));
    throwIfSetupInterrupted();
    const linuxBwrapPath = process.platform === "linux" ? await resolveLinuxBwrapPath() : undefined;
    if (process.platform === "linux" && linuxBwrapPath === undefined) {
      throw new Error("Linux sandboxing requires Bubblewrap (`bwrap`) to be installed");
    }
    if (process.platform === "linux") {
      bridgeRoot = await mkdtemp("/tmp/pir-bridge-");
      bridge = await startLinuxProxyBridge(proxy.url, path.join(bridgeRoot, "proxy.sock"));
      throwIfSetupInterrupted();
    }
    const sharedRuntimeReadPaths = [
      ...validated.runtimeReadPaths,
      sandboxRuntimeExecutable,
      ...(await macosRuntimeReadPaths(process.execPath)),
    ];
    const probeConfig = buildEvalSandboxConfig({
      platform: process.platform as "darwin" | "linux" | "win32",
      runDir: validated.runDir,
      runtimeReadPaths: [...sharedRuntimeReadPaths, probeScript, probeSpec],
      parentProxyUrl: proxy.url,
    });
    const actorConfig = buildEvalSandboxConfig({
      platform: process.platform as "darwin" | "linux" | "win32",
      runDir: validated.runDir,
      runtimeReadPaths: [
        ...sharedRuntimeReadPaths,
        launcherScript,
        launchSpec,
        piHome.agentDir,
        ...buildEvalExecutableReadPaths(resolvedExecutable, piInstallation),
      ],
      writableScratchPaths: [piHome.homeDir, piHome.tmpDir],
      parentProxyUrl: proxy.url,
    });
    process.env.PIONEER_HOST_SECRET = randomBytes(32).toString("hex");
    const timeoutMs = options.timeoutMs ?? 300_000;
    throwIfSetupInterrupted();
    const probeResult = await sandboxAndCapture(
      probeConfig,
      [sandboxRuntimeExecutable, probeScript, probeSpec],
      validated.runDir,
      Math.min(timeoutMs, 30_000),
      linuxBwrapPath,
      bridge?.socketPath,
      sandboxRuntimeExecutable,
    );
    if (probeResult.interrupted !== undefined) {
      completedResult = probeResult;
    } else if (probeResult.exitCode !== 0 || probeResult.stdout.trim() !== "isolation-ok") {
      throw new Error(
        `Eval isolation probe failed closed: ${probeResult.stderr || probeResult.stdout}`,
      );
    } else if ((await readFile(deniedWritePath, "utf8")) !== OUTSIDE_SENTINEL_CONTENT) {
      throw new Error("Eval isolation probe failed closed: host sentinel was modified");
    } else {
      throwIfSetupInterrupted();
      const result = await sandboxAndCapture(
        actorConfig,
        [sandboxRuntimeExecutable, launcherScript, launchSpec],
        validated.runDir,
        timeoutMs,
        linuxBwrapPath,
        bridge?.socketPath,
        sandboxRuntimeExecutable,
      );
      completedResult = {
        ...result,
        ...(readiness.warning === undefined ? {} : { warning: readiness.warning }),
      };
    }
  } catch (error) {
    if (error instanceof EvalSetupInterrupted)
      completedResult = interruptedEvalResult(error.signal);
    else primaryFailure = error;
  } finally {
    delete process.env.PIONEER_HOST_SECRET;
    const cleanupResults = await Promise.allSettled([
      bridge?.close(),
      bridgeRoot === undefined ? undefined : rm(bridgeRoot, { recursive: true, force: true }),
      proxy?.close(),
      lanProbe?.close(),
      unlink(deniedWritePath).catch(() => undefined),
      rm(isolationDir, { recursive: true, force: true }),
    ]);
    cleanupFailure = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "Eval execution failed and temporary state cleanup also failed",
    );
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (primaryFailure !== undefined) throw primaryFailure;
  if (interruption.signal !== undefined && completedResult?.interrupted === undefined) {
    completedResult = interruptedEvalResult(interruption.signal, completedResult);
  }
  if (completedResult === undefined) throw new Error("Eval run ended without a result");
  return completedResult;
}
