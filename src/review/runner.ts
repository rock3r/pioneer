import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnosticMessage } from "../diagnostics.js";
import { resolveLinuxBwrapPath } from "../eval-run/linux-install.js";
import { macosRuntimeReadPaths } from "../eval-run/macos-runtime.js";
import {
  resolveAnyTarget,
  resolvePublicTarget,
  startEgressProxy,
  type startPublicEgressProxy,
} from "../eval-run/public-egress-proxy.js";
import { defaultPiAgentDir, prepareIsolatedPiHome } from "../pi-home.js";
import { thinkingFromModelShorthand } from "../pi-model-selection.js";
import { assertPiReady } from "../pi-readiness.js";
import { optimizePiStartupCommand } from "../pi-startup.js";
import { buildLinuxSandboxArgv, buildMacosSandboxArgv } from "../sandbox/launcher.js";
import { type LinuxProxyBridge, startLinuxProxyBridge } from "../sandbox/linux-proxy-bridge.js";
import { assertNativeSandboxReady } from "../sandbox/platform-readiness.js";
import { isThinkingLevel, type ThinkingLevel } from "../thinking-level.js";
import {
  buildReviewSandboxConfig,
  type ReviewNetworkMode,
  validateReviewPaths,
} from "./isolation.js";
import { writeReviewReport } from "./report-output.js";
import { completeReviewRpc } from "./rpc-outcome.js";

export interface ReviewRequest {
  readonly sourceDir: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly piHomeSource?: string;
  readonly allowReadPaths?: readonly string[];
  readonly allowWritePaths?: readonly string[];
  readonly reportPath?: string;
  readonly network?: ReviewNetworkMode;
  readonly allowUnsandboxedWindows?: boolean;
  readonly timeoutMs?: number;
}

export interface ReviewResult {
  readonly report: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly sandboxed: boolean;
  readonly warning?: string;
  readonly reportWriteError?: string;
}

const WINDOWS_WARNING =
  "Windows review execution is unsandboxed. Read-only behavior and path restrictions are instructions, not operating-system security boundaries.";

function combineWarnings(...warnings: readonly (string | undefined)[]): string | undefined {
  const present = warnings.filter((warning): warning is string => warning !== undefined);
  return present.length === 0 ? undefined : present.join("\n");
}

function executableOnPath(name: string): string {
  if (name.includes(path.sep)) return path.resolve(name);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

async function piRuntimePaths(executable: string): Promise<string[]> {
  const paths =
    process.platform === "darwin"
      ? ["/System", "/usr", "/bin", "/sbin", "/Library/Apple/System", "/private/etc/ssl"]
      : ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts"];
  try {
    const link = executableOnPath(executable);
    const target = await realpath(link);
    paths.push(link, target);
    let directory = path.dirname(target);
    while (directory !== path.dirname(directory)) {
      if (existsSync(path.join(directory, "package.json"))) {
        paths.push(directory);
        break;
      }
      directory = path.dirname(directory);
    }
  } catch {
    // Pi readiness reports the actionable executable error.
  }
  return [...new Set(paths.filter(existsSync))];
}

export function reviewProcessEnvironment(
  sandboxEnvironment: Readonly<Record<string, string>>,
  piEnvironment: Readonly<Record<string, string>>,
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    ["PATH", "PATHEXT", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "ComSpec"].flatMap((name) => {
      const value = runtimeEnvironment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  if (process.platform === "darwin") {
    base.SSL_CERT_FILE = "/private/etc/ssl/cert.pem";
    base.OPENSSL_CONF = "/private/etc/ssl/openssl.cnf";
  }
  return { ...base, ...sandboxEnvironment, ...piEnvironment };
}

export async function persistReviewReport(
  report: string,
  reportPath: string | undefined,
): Promise<string | undefined> {
  if (reportPath === undefined) return undefined;
  try {
    await writeReviewReport(reportPath, report);
    return undefined;
  } catch (error) {
    return diagnosticMessage(
      "REVIEW_REPORT_WRITE_FAILED",
      `Pioneer received a review report but could not persist it at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assistantText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text || undefined;
}

function processOutcomeContext(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  return `exit ${exitCode ?? "unknown"}; signal ${signal ?? "none"}; stderr: ${stderr.trim() || "none"}`;
}

export async function runReviewRpc(
  argv: readonly [string, ...string[]],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let report = "";
    let finalReport: string | undefined;
    let settled = false;
    let completed = false;
    let terminalFailure: Error | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const eventTypes = new Set<string>();
    const diagnostics: string[] = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve(report.trim());
    };
    const terminate = (error: Error): void => {
      if (terminalFailure !== undefined || timedOut) return;
      terminalFailure = error;
      child.kill("SIGKILL");
    };
    const consume = (): void => {
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline).replace(/\r$/, "");
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          terminate(new Error("Pi RPC returned malformed JSONL"));
          return;
        }
        if (typeof event !== "object" || event === null) continue;
        const record = event as Record<string, unknown>;
        if (typeof record.type === "string") eventTypes.add(record.type);
        if (record.type === "response" && record.success === false) {
          terminate(
            new Error(
              `Pi RPC rejected the review prompt: ${String(record.error ?? "unknown error")}`,
            ),
          );
          return;
        }
        if (record.type === "message_update") {
          const update = record.assistantMessageEvent;
          if (typeof update === "object" && update !== null) {
            const typed = update as Record<string, unknown>;
            if (typed.type === "text_delta" && typeof typed.delta === "string")
              report += typed.delta;
          }
        }
        if (record.type === "message_end") {
          finalReport = assistantText(record.message) ?? finalReport;
          if (typeof record.message === "object" && record.message !== null) {
            const message = record.message as Record<string, unknown>;
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              const detail =
                typeof message.errorMessage === "string"
                  ? message.errorMessage.replaceAll(/\s+/g, " ").slice(0, 500)
                  : "no detail";
              diagnostics.push(`assistant stopReason=${String(message.stopReason)}: ${detail}`);
            }
          }
        }
        if (record.type === "extension_error") diagnostics.push("extension_error");
        if (record.type === "turn_end") {
          finalReport = assistantText(record.message) ?? finalReport;
        }
        if (record.type === "agent_end" && Array.isArray(record.messages)) {
          for (const message of [...record.messages].reverse()) {
            const text = assistantText(message);
            if (text !== undefined) {
              finalReport = text;
              break;
            }
          }
        }
        if (record.type === "agent_settled") {
          report = finalReport ?? report;
          completed = true;
          child.stdin.end();
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalFailure !== undefined || timedOut) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) {
        terminate(new Error("Pi RPC output exceeded 4 MiB"));
      } else consume();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.once("error", (error) => {
      terminalFailure ??= error;
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        finish(
          new Error(
            diagnosticMessage(
              "REVIEW_TIMEOUT",
              `Pi review timed out after ${timeoutMs}ms (${processOutcomeContext(code, signal, stderr)})`,
            ),
          ),
        );
        return;
      }
      if (terminalFailure !== undefined) {
        finish(
          new Error(`${terminalFailure.message} (${processOutcomeContext(code, signal, stderr)})`),
        );
        return;
      }
      try {
        report = completeReviewRpc({
          completed,
          report: finalReport ?? report,
          exitCode: code,
          signal,
          eventTypes: [...eventTypes],
          diagnostics,
          stderr,
        });
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.write(`${JSON.stringify({ id: "review", type: "prompt", message: prompt })}\n`);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}

export async function runReview(request: ReviewRequest): Promise<ReviewResult> {
  if (!request.prompt.trim()) throw new Error("Review prompt must not be empty");
  if (request.thinking !== undefined && !isThinkingLevel(request.thinking))
    throw new Error(`Unsupported thinking level: ${String(request.thinking)}`);
  const paths = await validateReviewPaths(request);
  const windows = process.platform === "win32";
  if (windows && request.allowUnsandboxedWindows !== true)
    throw new Error(`${WINDOWS_WARNING} Pass --allow-unsandboxed-windows to proceed.`);
  const piHomeSource = request.piHomeSource ?? defaultPiAgentDir();
  const readiness = await assertPiReady({
    environment: { ...process.env, PI_CODING_AGENT_DIR: piHomeSource },
    ...(request.model === undefined ? {} : { requestedModel: request.model }),
  });
  const scratchBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const scratch = await realpath(await mkdtemp(path.join(scratchBase, "pir-")));
  let proxy: Awaited<ReturnType<typeof startPublicEgressProxy>> | undefined;
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;
  try {
    const piHome = await prepareIsolatedPiHome({
      sourceDir: piHomeSource,
      destination: path.join(scratch, "pi-home"),
      mode: "review",
    });
    const model = readiness.resolvedModel;
    const command: [string, ...string[]] = ["pi", "--mode", "rpc"];
    if (model !== undefined) command.push("--model", model);
    const thinking =
      request.thinking ??
      (request.model === undefined ? undefined : thinkingFromModelShorthand(request.model));
    if (thinking !== undefined) command.push("--thinking", thinking);
    const optimized = optimizePiStartupCommand(command, {
      disableExtensions: true,
      tools: ["read", "bash", "grep", "find", "ls"],
    });
    const environment = {
      ...optimized.environment,
      ...piHome.environment,
      HOME: piHome.homeDir,
      TMPDIR: piHome.tmpDir,
      ...(process.platform === "darwin"
        ? {
            OPENSSL_CONF: "/private/etc/ssl/openssl.cnf",
            SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
          }
        : {}),
    };
    const prompt = [
      "Perform a code review. The source and reference paths are read-only. Use the writable scratch directory for temporary notes or reports. Do not attempt to modify read-only paths.",
      `Source: ${paths.sourceDir}`,
      `Scratch: ${scratch}`,
      request.prompt,
    ].join("\n\n");
    const timeoutMs = request.timeoutMs ?? 900_000;
    if (windows) {
      const report = await runReviewRpc(
        optimized.command,
        paths.sourceDir,
        reviewProcessEnvironment({}, environment),
        prompt,
        timeoutMs,
      );
      const reportWriteError = await persistReviewReport(report, paths.reportPath);
      return {
        report,
        sandboxed: false,
        warning: combineWarnings(WINDOWS_WARNING, readiness.warning) ?? WINDOWS_WARNING,
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(reportWriteError === undefined ? {} : { reportWriteError }),
      };
    }
    await assertNativeSandboxReady();
    const network = request.network ?? "full";
    if (network !== "none") {
      proxy = await startEgressProxy(
        crypto.randomUUID(),
        network === "public" ? resolvePublicTarget : resolveAnyTarget,
      );
    }
    const bwrapPath = process.platform === "linux" ? await resolveLinuxBwrapPath() : undefined;
    if (process.platform === "linux" && bwrapPath === undefined) {
      throw new Error("Linux sandboxing requires Bubblewrap (`bwrap`) to be installed");
    }
    if (process.platform === "linux" && proxy !== undefined) {
      bridgeRoot = await mkdtemp("/tmp/pir-bridge-");
      bridge = await startLinuxProxyBridge(proxy.url, path.join(bridgeRoot, "proxy.sock"));
    }
    const config = buildReviewSandboxConfig({
      platform: process.platform as "darwin" | "linux",
      ...paths,
      scratchDir: scratch,
      runtimeReadPaths: [
        ...(await piRuntimePaths("pi")),
        ...(await piRuntimePaths("node")),
        ...(await macosRuntimeReadPaths(process.execPath)),
      ],
      network,
      ...(proxy === undefined ? {} : { parentProxyUrl: proxy.url }),
    });
    const launch =
      process.platform === "darwin"
        ? buildMacosSandboxArgv(config, optimized.command)
        : buildLinuxSandboxArgv(config, optimized.command, bwrapPath ?? "", bridge?.socketPath);
    const report = await runReviewRpc(
      launch.argv,
      paths.sourceDir,
      reviewProcessEnvironment(launch.environment, environment),
      prompt,
      timeoutMs,
    );
    const reportWriteError = await persistReviewReport(report, paths.reportPath);
    return {
      report,
      sandboxed: true,
      ...(readiness.warning === undefined ? {} : { warning: readiness.warning }),
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(reportWriteError === undefined ? {} : { reportWriteError }),
    };
  } finally {
    await bridge?.close();
    if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
    await proxy?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
