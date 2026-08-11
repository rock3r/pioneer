import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_WORK_LOG_BYTES = 16 * 1024 * 1024;
const WORK_LOG_TRUNCATION_RESERVE_BYTES = 512;
const RETAINED_DEFAULT_WORK_LOGS = 100;
const WORK_LOG_SYNC_INTERVAL_MS = 1_000;
const AUTO_WORK_LOG_NAME =
  /^review-\d{8}T\d{9}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;
const PI_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "agent_start",
  "auto_compaction_end",
  "auto_compaction_start",
  "auto_retry_end",
  "auto_retry_start",
  "error",
  "extension_error",
  "message_end",
  "message_start",
  "message_update",
  "response",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
  "turn_end",
  "turn_start",
]);
const PI_MESSAGE_UPDATE_TYPES = new Set([
  "text_delta",
  "text_end",
  "text_start",
  "thinking_delta",
  "thinking_end",
  "thinking_start",
  "toolcall_delta",
  "toolcall_end",
  "toolcall_start",
]);
const PI_TOOL_NAMES = new Set(["bash", "find", "grep", "ls", "read"]);
const PI_MESSAGE_ROLES = new Set(["assistant", "system", "tool", "user"]);
const PI_STOP_REASONS = new Set(["aborted", "error", "length", "stop", "toolUse"]);

export interface ReviewWorkLog {
  readonly path: string;
  readonly runId: string;
  record(type: string, details?: Readonly<Record<string, unknown>>): void;
  close(): void;
}

export interface OpenReviewWorkLogOptions {
  readonly runId?: string;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly fileOperations?: {
    readonly write?: (descriptor: number, buffer: Buffer, offset: number, length: number) => number;
    readonly sync: (descriptor: number) => void;
    readonly close: (descriptor: number) => void;
  };
}

export type ValidateReviewWorkLogTarget = (target: string) => Promise<void>;

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

export function reviewWorkLogDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  const pathApi = platformPath(platform);
  if (platform === "darwin") return pathApi.join(home, "Library", "Logs", "Pioneer", "reviews");
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    const root =
      localAppData !== undefined && pathApi.isAbsolute(localAppData)
        ? localAppData
        : pathApi.join(home, "AppData", "Local");
    return pathApi.join(root, "Pioneer", "Logs", "reviews");
  }
  const stateHome = environment.XDG_STATE_HOME;
  const root =
    stateHome !== undefined && pathApi.isAbsolute(stateHome)
      ? stateHome
      : pathApi.join(home, ".local", "state");
  return pathApi.join(root, "pioneer", "logs", "reviews");
}

function generatedDefaultReviewWorkLogPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  now = new Date(),
  id: string = crypto.randomUUID(),
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(id)) {
    throw new Error("Review work log identifier is invalid");
  }
  const timestamp = now.toISOString().replaceAll(/[-:.]/g, "");
  const directory = reviewWorkLogDirectory(environment, platform, home);
  return platformPath(platform).join(directory, `review-${timestamp}-${id}.jsonl`);
}

async function prepareDefaultReviewWorkLogDirectory(
  target: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const pathApi = platformPath(platform);
  const directory = pathApi.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink()) {
    throw new Error(`Review work log directory is a symbolic link: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`Review work log path is not a directory: ${directory}`);
  }
  if (platform !== "win32") await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  const existingLogs = entries
    .filter((entry) => entry.isFile() && AUTO_WORK_LOG_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removeCount = Math.max(0, existingLogs.length - (RETAINED_DEFAULT_WORK_LOGS - 1));
  for (const name of existingLogs.slice(0, removeCount)) {
    try {
      await unlink(pathApi.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function prepareValidatedDefaultReviewWorkLogPath(
  validateTarget: ValidateReviewWorkLogTarget,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  now = new Date(),
  id: string = crypto.randomUUID(),
): Promise<string> {
  const target = generatedDefaultReviewWorkLogPath(environment, platform, home, now, id);
  await validateTarget(target);
  await prepareDefaultReviewWorkLogDirectory(target, platform);
  return target;
}

export async function prepareDefaultReviewWorkLogPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  now = new Date(),
  id: string = crypto.randomUUID(),
): Promise<string> {
  return await prepareValidatedDefaultReviewWorkLogPath(
    async () => {},
    environment,
    platform,
    home,
    now,
    id,
  );
}

export function sanitizeWorkLogDiagnostic(value: string, secrets: readonly string[] = []): string {
  let sanitized = value.replaceAll(/\s+/g, " ");
  for (const secret of secrets) {
    const normalized = secret.replaceAll(/\s+/g, " ").trim();
    if (normalized) sanitized = sanitized.replaceAll(normalized, "[REDACTED]");
  }
  return sanitized
    .replaceAll(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "Authorization=[REDACTED]")
    .replaceAll(/\bbearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replaceAll(
      /\b(api[-_ ]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      (_match, label: string) => `${label}=[REDACTED]`,
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .trim()
    .slice(0, 500);
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" ? value : undefined;
}

function allowlistedStringField(
  record: Record<string, unknown>,
  name: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const value = stringField(record, name);
  if (value === undefined) return undefined;
  return allowed.has(value) ? value : "unrecognized";
}

function hashedStringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = stringField(record, name);
  return value === undefined
    ? undefined
    : createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function numberField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, name: string): boolean | undefined {
  const value = record[name];
  return typeof value === "boolean" ? value : undefined;
}

function definedFields(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

export function summarizePiEvent(
  event: unknown,
  _secrets: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof event !== "object" || event === null) return { eventType: "unrecognized" };
  const record = event as Record<string, unknown>;
  const rawEventType = stringField(record, "type");
  const eventType =
    rawEventType !== undefined && PI_EVENT_TYPES.has(rawEventType) ? rawEventType : "unrecognized";
  const base: Record<string, unknown> = {
    eventType,
  };

  if (eventType === "message_update") {
    const update = record.assistantMessageEvent;
    if (typeof update !== "object" || update === null) return base;
    const typed = update as Record<string, unknown>;
    const delta = stringField(typed, "delta");
    return definedFields({
      ...base,
      eventSubtype: allowlistedStringField(typed, "type", PI_MESSAGE_UPDATE_TYPES),
      contentIndex: numberField(typed, "contentIndex"),
      deltaBytes: delta === undefined ? undefined : Buffer.byteLength(delta),
    });
  }

  if (eventType.startsWith("tool_execution_")) {
    return definedFields({
      ...base,
      toolCallIdHash: hashedStringField(record, "toolCallId"),
      toolName: allowlistedStringField(record, "toolName", PI_TOOL_NAMES),
      isError: booleanField(record, "isError"),
    });
  }

  if (["message_start", "message_end", "turn_end"].includes(eventType)) {
    const message = record.message;
    if (typeof message !== "object" || message === null) return base;
    const typed = message as Record<string, unknown>;
    const messageDiagnostic = stringField(typed, "errorMessage");
    return definedFields({
      ...base,
      messageRole: allowlistedStringField(typed, "role", PI_MESSAGE_ROLES),
      stopReason: allowlistedStringField(typed, "stopReason", PI_STOP_REASONS),
      diagnosticPresent: messageDiagnostic === undefined ? undefined : true,
      diagnosticBytes:
        messageDiagnostic === undefined ? undefined : Buffer.byteLength(messageDiagnostic),
    });
  }

  const diagnostic =
    stringField(record, "errorMessage") ??
    stringField(record, "finalError") ??
    stringField(record, "error");
  return definedFields({
    ...base,
    attempt: numberField(record, "attempt"),
    maxAttempts: numberField(record, "maxAttempts"),
    delayMs: numberField(record, "delayMs"),
    success: booleanField(record, "success"),
    aborted: booleanField(record, "aborted"),
    willRetry: booleanField(record, "willRetry"),
    reasonPresent: stringField(record, "reason") === undefined ? undefined : true,
    reasonBytes:
      stringField(record, "reason") === undefined
        ? undefined
        : Buffer.byteLength(stringField(record, "reason") ?? ""),
    diagnosticPresent: diagnostic === undefined ? undefined : true,
    diagnosticBytes: diagnostic === undefined ? undefined : Buffer.byteLength(diagnostic),
  });
}

export async function openReviewWorkLog(
  target: string,
  options: OpenReviewWorkLogOptions = {},
): Promise<ReviewWorkLog> {
  const descriptor = openSync(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  const runId = options.runId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? MAX_WORK_LOG_BYTES;
  const writeDescriptor =
    options.fileOperations?.write ??
    ((fileDescriptor: number, buffer: Buffer, offset: number, length: number) =>
      writeSync(fileDescriptor, buffer, offset, length));
  const syncDescriptor = options.fileOperations?.sync ?? fsyncSync;
  const closeDescriptor = options.fileOperations?.close ?? closeSync;
  let sequence = 0;
  let bytesWritten = 0;
  let firstTimestamp: number | undefined;
  let lastSyncAt: number | undefined;
  let closed = false;
  let truncated = false;

  const append = (record: Readonly<Record<string, unknown>>, limit = maxBytes): boolean => {
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    const size = line.length;
    if (bytesWritten + size > limit) return false;
    let offset = 0;
    while (offset < size) {
      const written = writeDescriptor(descriptor, line, offset, size - offset);
      if (!Number.isInteger(written) || written <= 0 || written > size - offset) {
        throw new Error(`Review work log write returned an invalid byte count: ${written}`);
      }
      offset += written;
    }
    bytesWritten += size;
    return true;
  };

  const syncIfDue = (timestamp: Date): void => {
    if (lastSyncAt === undefined || timestamp.getTime() - lastSyncAt >= WORK_LOG_SYNC_INTERVAL_MS) {
      syncDescriptor(descriptor);
      lastSyncAt = timestamp.getTime();
    }
  };

  return {
    path: target,
    runId,
    record(type, details = {}) {
      if (closed) throw new Error(`Review work log is closed: ${target}`);
      if (truncated) return;
      const timestamp = now();
      firstTimestamp ??= timestamp.getTime();
      sequence += 1;
      const base = {
        schemaVersion: 1,
        timestamp: timestamp.toISOString(),
        elapsedMs: Math.max(0, timestamp.getTime() - firstTimestamp),
        runId,
        sequence,
      } as const;
      if (
        append(
          {
            ...details,
            ...base,
            type,
          },
          Math.max(0, maxBytes - WORK_LOG_TRUNCATION_RESERVE_BYTES),
        )
      ) {
        syncIfDue(timestamp);
        return;
      }
      truncated = true;
      append({
        ...base,
        type: "work_log_truncated",
        maxBytes,
      });
      syncIfDue(timestamp);
    },
    close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        syncDescriptor(descriptor);
      } catch (error) {
        failure = error;
      }
      try {
        closeDescriptor(descriptor);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
}
