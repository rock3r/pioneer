import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { diagnosticMessage } from "../diagnostics.js";
import { resolveLinuxBwrapPath } from "../eval-run/linux-install.js";
import { macosRuntimeReadPaths } from "../eval-run/macos-runtime.js";
import {
  resolveAnyTarget,
  resolvePublicTarget,
  startEgressProxy,
  type startPublicEgressProxy,
} from "../eval-run/public-egress-proxy.js";
import { PIONEER_VERSION } from "../package-metadata.js";
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
  validateProspectiveReviewWorkLogPath,
  validateReviewPaths,
} from "./isolation.js";
import { writeReviewReport } from "./report-output.js";
import { completeReviewRpc } from "./rpc-outcome.js";
import {
  openReviewWorkLog,
  prepareValidatedDefaultReviewWorkLogPath,
  type ReviewWorkLog,
  sanitizeWorkLogDiagnostic,
  summarizePiEvent,
} from "./work-log.js";

export interface ReviewRequest {
  readonly sourceDir: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly piHomeSource?: string;
  readonly allowReadPaths?: readonly string[];
  readonly allowWritePaths?: readonly string[];
  readonly reportPath?: string;
  readonly workLogPath?: string;
  readonly onWorkLogReady?: (path: string) => void;
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
  readonly workLogPath: string;
}

const WINDOWS_WARNING =
  "Windows review execution is unsandboxed. Read-only behavior and path restrictions are instructions, not operating-system security boundaries.";
const PIPE_CLOSE_GRACE_MS = 1_000;
const MAX_RPC_OUTPUT_BYTES = 4 * 1024 * 1024;
const WORK_LOG_HEARTBEAT_MS = 5_000;

function reviewWorkLogWriteError(workLog: ReviewWorkLog, error: unknown): Error {
  return new Error(
    diagnosticMessage(
      "REVIEW_WORK_LOG_WRITE_FAILED",
      `Pioneer could not continue the real-time review work log at ${workLog.path}: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}

function recordReviewWorkLog(
  workLog: ReviewWorkLog,
  type: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  try {
    workLog.record(type, details);
  } catch (error) {
    throw reviewWorkLogWriteError(workLog, error);
  }
}

function closeReviewWorkLog(workLog: ReviewWorkLog): void {
  try {
    workLog.close();
  } catch (error) {
    throw reviewWorkLogWriteError(workLog, error);
  }
}

export interface RunReviewRpcOptions {
  readonly workLog?: ReviewWorkLog;
  readonly heartbeatMs?: number;
}

export function reviewTools(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "linux" ? ["read", "bash", "grep", "find", "ls"] : ["read", "ls"];
}

export async function createReviewScratchDirectory(
  scratchBase: string,
  afterCreate: (scratch: string) => void | Promise<void> = () => {},
): Promise<string> {
  const created = await mkdtemp(path.join(scratchBase, "pir-"));
  try {
    const scratch = await realpath(created);
    await afterCreate(scratch);
    return scratch;
  } catch (error) {
    await rm(created, { recursive: true, force: true });
    throw error;
  }
}

export function requiresGitInspection(prompt: string): boolean {
  return (
    /\b(?:review|inspect|compare)\b[^.]*\b(?:(?:staged|unstaged|untracked)\s+(?:changes|files)|working[-\s]tree|current\s+changes|changes\s+between\s+(?:(?:main\b(?!\s+thread\b)|master\b|HEAD\b|origin\/[0-9a-z._/-]+)\s+and\s+[0-9a-z._/-]+|[0-9a-z._/-]+\s+and\s+(?:main\b(?!\s+thread\b)|master\b|HEAD\b|origin\/[0-9a-z._/-]+))|commit\s+(?:`[0-9a-f]{6,64}`|`?(?=[0-9a-f]{6,64}`?\b)(?=[0-9a-f`]*\d)[0-9a-f]{6,64}`?|HEAD(?:[~^]\d*)?\b)|changes\s+introduced\s+by\s+`?(?=[0-9a-f]{6,64}`?\b)(?=[0-9a-f`]*\d)(?=[0-9a-f`]*[a-f])[0-9a-f]{6,64}`?|`?(?=[0-9a-f]{6,64}`?\b)(?=[0-9a-f`]*\d)(?=[0-9a-f`]*[a-f])[0-9a-f]{6,64}`?|this\s+branch(?!\s+of\b)|branch\s+(?:against|with|compared|`?[0-9a-z._-]+\/[0-9a-z._/-]+`?)|merge\s+base|(?:the\s+)?diff(?:\s*(?:$|[.?!])|\s+(?:against|between|of|from)\b)|against\s+origin\/|(?:changes|commit|branch|diff)\b[^.]*\b(?:against\s+(?:HEAD\b|main\b(?!\s+thread\b)|master\b)|since\s+origin\/)|(?:main|master|HEAD|origin\/[0-9a-z._/-]+)\.{2,3}[0-9a-z._/-]+|[0-9a-z._/-]+\.{2,3}(?:main|master|HEAD|origin\/[0-9a-z._/-]+))/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\s+(?:the\s+)?branch\s+(?!(?:to|logic|selection|handling|coverage)\b)`?[0-9a-z._-]+`?\b/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\bcommit\s+(?!(?:message|facade|headers|handling)\b)`?[0-9a-z._/-]+(?:[~^]\d*)?`?/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\bchanges\b[^.]*\bsince\s+(?:HEAD\b|main\b(?!\s+thread\b)|master\b)/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\btag\s+(?!(?:parser|handling|logic|selection|coverage|implementation)(?=\s|$|[.,?!:'"]))(?:`[0-9a-z._/-]+`|[0-9a-z._/-]+)/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\b(?:changes|diff)\s+against\s+(?:`[0-9a-z._/-]+`|[0-9a-z._/-]+)(?=$|[.?!])/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\b(?:the\s+)?(?:last|latest|previous)\s+commit(?!\s+(?:message|facade|headers|handling)\b)/i.test(
      prompt,
    ) ||
    /\b(?:[Rr]eview|[Ii]nspect|[Cc]ompare)\s+(?:[Tt]he\s+)?HEAD(?:[~^]\d*)?(?=$|[.?!]|\s+(?:for|against|with)\b)/.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\bchanges\b[^.]*\bsince\s+`[0-9a-z._/-]+`/i.test(prompt) ||
    /\b(?:review|inspect|compare)\s+(?:the\s+)?origin\/[0-9a-z._/-]+/i.test(prompt) ||
    /\bfocus\s+on\s+(?:the\s+)?(?:current(?:\s+working[-\s]tree)?\s+changes|working[-\s]tree|(?:staged|unstaged|untracked)\s+(?:changes|files)|(?:pull\s+request|PR)\s*#?\s*\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b)/i.test(
      prompt,
    ) ||
    /\b(?:review|inspect|compare)\b[^.]*\b(?:pull\s+request|PR)\s*#?\s*\d+\b/i.test(prompt) ||
    /\b(?:review|inspect|compare)\b[^.]*\bhttps?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b/i.test(
      prompt,
    )
  );
}

export function buildReviewPrompt(
  sourceDir: string,
  scratchDir: string,
  requestPrompt: string,
): string {
  return [
    "Perform a code review. The source and reference paths are read-only. Use the writable scratch directory for temporary notes or reports. Do not attempt to modify read-only paths.",
    `Source: ${sourceDir}`,
    `Scratch: ${scratchDir}`,
    requestPrompt,
  ].join("\n\n");
}

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
  return text;
}

function clearAssistantFailures(diagnostics: string[]): void {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    if (diagnostics[index]?.startsWith("assistant stopReason=")) diagnostics.splice(index, 1);
  }
}

function isAssistantMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).role === "assistant"
  );
}

function recordAssistantFailure(
  value: unknown,
  diagnostics: string[],
  requireAssistantRole = true,
): void {
  if (typeof value !== "object" || value === null) return;
  const message = value as Record<string, unknown>;
  const assistantMessage = message.role === "assistant";
  if (requireAssistantRole && !assistantMessage) return;
  if (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse"
  ) {
    clearAssistantFailures(diagnostics);
    return;
  }
  if (message.stopReason !== "error" && message.stopReason !== "aborted") {
    return;
  }
  clearAssistantFailures(diagnostics);
  const detail =
    typeof message.errorMessage === "string"
      ? message.errorMessage.replaceAll(/\s+/g, " ").slice(0, 500)
      : "no detail";
  diagnostics.push(`assistant stopReason=${String(message.stopReason)}: ${detail}`);
}

function recordAssistantEventFailure(value: unknown, diagnostics: string[]): void {
  if (typeof value !== "object" || value === null) return;
  const event = value as Record<string, unknown>;
  if (event.type !== "error" || (event.reason !== "error" && event.reason !== "aborted")) return;

  const error = event.error;
  if (typeof error === "object" && error !== null) {
    recordAssistantFailure(
      { ...(error as Record<string, unknown>), role: "assistant", stopReason: event.reason },
      diagnostics,
    );
    return;
  }

  clearAssistantFailures(diagnostics);
  diagnostics.push(`assistant stopReason=${event.reason}: no detail`);
}

function processOutcomeContext(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  return `exit ${exitCode ?? "unknown"}; signal ${signal ?? "none"}; stderr: ${stderr.trim() || "none"}`;
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
      child.kill("SIGKILL");
      return;
    }
    const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
    let fallbackUsed = false;
    const fallback = (): void => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      child.kill("SIGKILL");
    };
    const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The child may have already exited; the direct signal below is still safe.
    }
  }
  child.kill("SIGKILL");
}

export async function runReviewRpc(
  argv: readonly [string, ...string[]],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  prompt: string,
  timeoutMs: number,
  options: RunReviewRpcOptions = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    let stderr = "";
    let report = "";
    let finalReport: string | undefined;
    let settled = false;
    let completed = false;
    let terminalFailure: Error | undefined;
    let timedOut = false;
    let childExited = false;
    let acceptRpcEvents = true;
    let containmentLost = false;
    let timer: NodeJS.Timeout | undefined;
    let pipeCloseTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let onSigint: (() => void) | undefined;
    let onSigterm: (() => void) | undefined;
    const eventTypes = new Set<string>();
    const diagnostics: string[] = [];
    let workLogFailure: Error | undefined;
    let lastPiEvent = "process_started";
    let lastPiEventAt = Date.now();
    let stderrBytes = 0;
    const recordWorkLog = (type: string, details: Readonly<Record<string, unknown>> = {}): void => {
      if (options.workLog === undefined || workLogFailure !== undefined) return;
      try {
        options.workLog.record(type, details);
      } catch (error) {
        workLogFailure = new Error(
          diagnosticMessage(
            "REVIEW_WORK_LOG_WRITE_FAILED",
            `Pioneer could not continue the real-time review work log at ${options.workLog.path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        terminalFailure ??= workLogFailure;
        terminateProcessTree(child);
      }
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      if (error === undefined) {
        recordWorkLog("pi_rpc_completed", {
          reportBytes: Buffer.byteLength(report.trim()),
          rpcBytes: stdoutBytes,
          stderrBytes,
        });
      } else {
        recordWorkLog("pi_rpc_failed", {
          diagnostic: sanitizeWorkLogDiagnostic(error.message, [prompt]),
          rpcBytes: stdoutBytes,
          stderrBytes,
        });
      }
      const finalError = workLogFailure ?? error;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pipeCloseTimer !== undefined) clearTimeout(pipeCloseTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (onSigint !== undefined) process.off("SIGINT", onSigint);
      if (onSigterm !== undefined) process.off("SIGTERM", onSigterm);
      if (finalError) reject(finalError);
      else resolve(report.trim());
    };
    const terminate = (error: Error): void => {
      if (terminalFailure !== undefined || timedOut) return;
      terminalFailure = error;
      recordWorkLog("pi_termination_requested", {
        diagnostic: sanitizeWorkLogDiagnostic(error.message, [prompt]),
      });
      terminateProcessTree(child);
    };
    const schedulePipeCloseFallback = (): void => {
      if (pipeCloseTimer !== undefined) return;
      pipeCloseTimer = setTimeout(() => {
        containmentLost = true;
        terminateProcessTree(child);
        child.stdout.destroy();
        child.stderr.destroy();
      }, PIPE_CLOSE_GRACE_MS);
    };
    onSigint = () => {
      if (!childExited) terminate(new Error("Pi review interrupted by SIGINT"));
    };
    onSigterm = () => {
      if (!childExited) terminate(new Error("Pi review interrupted by SIGTERM"));
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    recordWorkLog("pi_process_started", {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      timeoutMs,
    });
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
        lastPiEvent =
          typeof record.type === "string"
            ? sanitizeWorkLogDiagnostic(record.type, [prompt])
            : "unrecognized";
        lastPiEventAt = Date.now();
        recordWorkLog("pi_event", summarizePiEvent(record, [prompt]));
        if (workLogFailure !== undefined) return;
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
          recordAssistantFailure(record.message, diagnostics);
          recordAssistantEventFailure(update, diagnostics);
          if (typeof update === "object" && update !== null) {
            const typed = update as Record<string, unknown>;
            if (typed.type === "start") {
              report = "";
              finalReport = undefined;
              clearAssistantFailures(diagnostics);
            }
            if (typed.type === "done") {
              finalReport = assistantText(typed.message) ?? "";
              recordAssistantFailure(typed.message, diagnostics);
            }
            if (typed.type === "text_delta" && typeof typed.delta === "string")
              report += typed.delta;
          }
        }
        if (record.type === "message_end") {
          if (isAssistantMessage(record.message)) finalReport = assistantText(record.message) ?? "";
          recordAssistantFailure(record.message, diagnostics);
        }
        if (record.type === "extension_error") diagnostics.push("extension_error");
        if (record.type === "turn_end") {
          if (isAssistantMessage(record.message)) finalReport = assistantText(record.message) ?? "";
          recordAssistantFailure(record.message, diagnostics);
        }
        if (record.type === "agent_end" && Array.isArray(record.messages)) {
          for (const message of [...record.messages].reverse()) {
            if (!isAssistantMessage(message)) continue;
            const text = assistantText(message);
            recordAssistantFailure(message, diagnostics);
            finalReport = text ?? "";
            break;
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
      if (!acceptRpcEvents || terminalFailure !== undefined || timedOut) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RPC_OUTPUT_BYTES) {
        terminate(new Error("Pi RPC output exceeded 4 MiB"));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
      consume();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      recordWorkLog("pi_stderr", { chunkBytes: chunk.length, totalBytes: stderrBytes });
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.once("error", (error) => {
      recordWorkLog("pi_process_error", {
        diagnostic: sanitizeWorkLogDiagnostic(error.message, [prompt]),
      });
      terminalFailure ??= error;
    });
    child.once("exit", (code, signal) => {
      childExited = true;
      recordWorkLog("pi_process_exit", {
        exitCode: code,
        signal: signal ?? "none",
      });
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      schedulePipeCloseFallback();
      setImmediate(() => {
        acceptRpcEvents = false;
      });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (terminalFailure === undefined && !timedOut) {
        stdout += stdoutDecoder.end();
        consume();
      }
      if (workLogFailure !== undefined) {
        finish(workLogFailure);
        return;
      }
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
      if (containmentLost) {
        finish(
          new Error(
            diagnosticMessage(
              "REVIEW_PROCESS_CONTAINMENT_FAILED",
              "Pi exited but a descendant retained its RPC output pipe; Pioneer could not prove that the review process tree stopped.",
            ),
          ),
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
    lastPiEvent = "prompt_sent";
    lastPiEventAt = Date.now();
    recordWorkLog("pi_prompt_sent", { promptBytes: Buffer.byteLength(prompt) });
    heartbeatTimer = setInterval(() => {
      recordWorkLog("heartbeat", {
        phase: "pi_rpc",
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        lastPiEvent,
        idleMs: Math.max(0, Date.now() - lastPiEventAt),
        rpcBytes: stdoutBytes,
        stderrBytes,
      });
    }, options.heartbeatMs ?? WORK_LOG_HEARTBEAT_MS);
    heartbeatTimer.unref();
    timer = setTimeout(() => {
      timedOut = true;
      recordWorkLog("pi_timeout", { timeoutMs });
      terminateProcessTree(child);
      if (childExited) schedulePipeCloseFallback();
    }, timeoutMs);
  });
}

export async function runReview(request: ReviewRequest): Promise<ReviewResult> {
  if (!request.prompt.trim()) throw new Error("Review prompt must not be empty");
  if (request.thinking !== undefined && !isThinkingLevel(request.thinking))
    throw new Error(`Unsupported thinking level: ${String(request.thinking)}`);
  let requestedWorkLogPath = request.workLogPath;
  if (requestedWorkLogPath === undefined) {
    try {
      requestedWorkLogPath = await prepareValidatedDefaultReviewWorkLogPath(async (candidate) => {
        await validateProspectiveReviewWorkLogPath({ ...request, workLogPath: candidate });
      });
    } catch (error) {
      throw new Error(
        diagnosticMessage(
          "REVIEW_WORK_LOG_CREATE_FAILED",
          `Pioneer could not prepare the default real-time review work-log directory: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  const paths = await validateReviewPaths({ ...request, workLogPath: requestedWorkLogPath });
  if (paths.workLogPath === undefined) throw new Error("Review work log path was not validated");
  let workLog: ReviewWorkLog;
  try {
    workLog = await openReviewWorkLog(paths.workLogPath);
  } catch (error) {
    throw new Error(
      diagnosticMessage(
        "REVIEW_WORK_LOG_CREATE_FAILED",
        `Pioneer could not create the real-time review work log at ${paths.workLogPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  try {
    request.onWorkLogReady?.(workLog.path);
    const windows = process.platform === "win32";
    const network = request.network ?? "full";
    const timeoutMs = request.timeoutMs ?? 900_000;
    recordReviewWorkLog(workLog, "review_started", {
      pioneerVersion: PIONEER_VERSION,
      platform: process.platform,
      controllerPid: process.pid,
      sourceDir: paths.sourceDir,
      promptBytes: Buffer.byteLength(request.prompt),
      network,
      timeoutMs,
      requestedModel: request.model ?? "default",
      requestedThinking: request.thinking ?? "default",
      reportRequested: paths.reportPath !== undefined,
      sandboxed: !windows,
    });
    if (windows && request.allowUnsandboxedWindows !== true)
      throw new Error(`${WINDOWS_WARNING} Pass --allow-unsandboxed-windows to proceed.`);
    if (process.platform !== "linux" && requiresGitInspection(request.prompt))
      throw new Error(
        "Git-target reviews require Linux, where Pioneer can inspect Git inside Bubblewrap. macOS and Windows support source-only reviews.",
      );

    const piHomeSource = request.piHomeSource ?? defaultPiAgentDir();
    recordReviewWorkLog(workLog, "stage_started", { stage: "pi_readiness" });
    const readiness = await assertPiReady({
      environment: { ...process.env, PI_CODING_AGENT_DIR: piHomeSource },
      ...(request.model === undefined ? {} : { requestedModel: request.model }),
    });
    recordReviewWorkLog(workLog, "stage_completed", {
      stage: "pi_readiness",
      piVersion: readiness.version ?? "unknown",
      model: readiness.resolvedModel ?? "default",
      warning: readiness.warning !== undefined,
    });

    const scratchBase = windows ? os.tmpdir() : "/tmp";
    recordReviewWorkLog(workLog, "stage_started", { stage: "scratch_creation" });
    const scratch = await createReviewScratchDirectory(scratchBase, () => {
      recordReviewWorkLog(workLog, "stage_completed", { stage: "scratch_creation" });
    });
    let proxy: Awaited<ReturnType<typeof startPublicEgressProxy>> | undefined;
    let bridge: LinuxProxyBridge | undefined;
    let bridgeRoot: string | undefined;
    let reviewResult: ReviewResult | undefined;
    let runFailure: Error | undefined;
    let reportBytes = 0;
    try {
      recordReviewWorkLog(workLog, "stage_started", { stage: "pi_home_snapshot" });
      const piHome = await prepareIsolatedPiHome({
        sourceDir: piHomeSource,
        destination: path.join(scratch, "pi-home"),
        mode: "review",
      });
      recordReviewWorkLog(workLog, "stage_completed", { stage: "pi_home_snapshot" });
      const model = readiness.resolvedModel;
      const command: [string, ...string[]] = ["pi", "--mode", "rpc"];
      if (model !== undefined) command.push("--model", model);
      const thinking =
        request.thinking ??
        (request.model === undefined ? undefined : thinkingFromModelShorthand(request.model));
      if (thinking !== undefined) command.push("--thinking", thinking);
      const optimized = optimizePiStartupCommand(command, {
        disableExtensions: true,
        tools: reviewTools(),
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
      const prompt = buildReviewPrompt(paths.sourceDir, scratch, request.prompt);
      let report: string;
      let sandboxed: boolean;
      if (windows) {
        recordReviewWorkLog(workLog, "stage_started", { stage: "pi_rpc" });
        report = await runReviewRpc(
          optimized.command,
          paths.sourceDir,
          reviewProcessEnvironment({}, environment),
          prompt,
          timeoutMs,
          { workLog },
        );
        sandboxed = false;
      } else {
        recordReviewWorkLog(workLog, "stage_started", { stage: "sandbox_readiness" });
        await assertNativeSandboxReady();
        recordReviewWorkLog(workLog, "stage_completed", { stage: "sandbox_readiness" });
        if (network !== "none") {
          recordReviewWorkLog(workLog, "stage_started", { stage: "network_proxy" });
          proxy = await startEgressProxy(
            crypto.randomUUID(),
            network === "public" ? resolvePublicTarget : resolveAnyTarget,
          );
          recordReviewWorkLog(workLog, "stage_completed", { stage: "network_proxy" });
        }
        const bwrapPath = process.platform === "linux" ? await resolveLinuxBwrapPath() : undefined;
        if (process.platform === "linux" && bwrapPath === undefined) {
          throw new Error("Linux sandboxing requires Bubblewrap (`bwrap`) to be installed");
        }
        if (process.platform === "linux" && proxy !== undefined) {
          bridgeRoot = await mkdtemp("/tmp/pir-bridge-");
          bridge = await startLinuxProxyBridge(proxy.url, path.join(bridgeRoot, "proxy.sock"));
        }
        recordReviewWorkLog(workLog, "stage_started", { stage: "sandbox_launch" });
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
            ? buildMacosSandboxArgv({ ...config, allowProcessFork: false }, optimized.command)
            : buildLinuxSandboxArgv(config, optimized.command, bwrapPath ?? "", bridge?.socketPath);
        recordReviewWorkLog(workLog, "stage_completed", { stage: "sandbox_launch" });
        recordReviewWorkLog(workLog, "stage_started", { stage: "pi_rpc" });
        report = await runReviewRpc(
          launch.argv,
          paths.sourceDir,
          reviewProcessEnvironment(launch.environment, environment),
          prompt,
          timeoutMs,
          { workLog },
        );
        sandboxed = true;
      }
      reportBytes = Buffer.byteLength(report);
      recordReviewWorkLog(workLog, "stage_completed", { stage: "pi_rpc", reportBytes });
      recordReviewWorkLog(workLog, "stage_started", { stage: "report_persistence" });
      const reportWriteError = await persistReviewReport(report, paths.reportPath);
      recordReviewWorkLog(workLog, "stage_completed", {
        stage: "report_persistence",
        requested: paths.reportPath !== undefined,
        success: reportWriteError === undefined,
        ...(reportWriteError === undefined
          ? {}
          : { diagnostic: sanitizeWorkLogDiagnostic(reportWriteError, [request.prompt]) }),
      });
      reviewResult = {
        report,
        sandboxed,
        workLogPath: workLog.path,
        ...(windows
          ? { warning: combineWarnings(WINDOWS_WARNING, readiness.warning) ?? WINDOWS_WARNING }
          : readiness.warning === undefined
            ? {}
            : { warning: readiness.warning }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(reportWriteError === undefined ? {} : { reportWriteError }),
      };
    } catch (error) {
      runFailure = error instanceof Error ? error : new Error(String(error));
    }
    let cleanupFailure: Error | undefined;
    try {
      recordReviewWorkLog(workLog, "stage_started", { stage: "cleanup" });
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
    }
    for (const cleanup of [
      async () => bridge?.close(),
      async () => {
        if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
      },
      async () => proxy?.close(),
      async () => rm(scratch, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    try {
      recordReviewWorkLog(workLog, "stage_completed", {
        stage: "cleanup",
        success: cleanupFailure === undefined,
        ...(cleanupFailure === undefined
          ? {}
          : { diagnostic: sanitizeWorkLogDiagnostic(cleanupFailure.message) }),
      });
      if (reviewResult !== undefined && cleanupFailure === undefined) {
        recordReviewWorkLog(workLog, "review_completed", {
          reportBytes,
          status: reviewResult.reportWriteError === undefined ? "success" : "report_write_failed",
        });
      }
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (runFailure !== undefined) throw runFailure;
    if (reviewResult === undefined) throw new Error("Review completed without a result");
    return reviewResult;
  } catch (error) {
    let failure = error instanceof Error ? error : new Error(String(error));
    try {
      workLog.record("review_failed", {
        diagnostic: sanitizeWorkLogDiagnostic(failure.message, [request.prompt]),
      });
    } catch (workLogError) {
      failure = reviewWorkLogWriteError(workLog, workLogError);
    }
    throw failure;
  } finally {
    closeReviewWorkLog(workLog);
  }
}
