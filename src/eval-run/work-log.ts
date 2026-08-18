import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnosticMessage, isCredentialLabel, sanitizeDiagnostic } from "../diagnostics.js";

const MAX_WORK_LOG_BYTES = 16 * 1024 * 1024;
const MIN_WORK_LOG_BYTES = 1_024;
const WORK_LOG_TRUNCATION_RESERVE_BYTES = 512;

export interface EvalWorkLog {
  readonly path: string;
  readonly runId: string;
  record(type: string, details?: Readonly<Record<string, unknown>>): void;
  close(): void;
}

export interface OpenEvalWorkLogOptions {
  readonly runId?: string;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly platform?: NodeJS.Platform;
}

export function evalWorkLogDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin") return pathApi.join(home, "Library", "Logs", "Pioneer", "evals");
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    const root =
      localAppData !== undefined && pathApi.isAbsolute(localAppData)
        ? localAppData
        : pathApi.join(home, "AppData", "Local");
    return pathApi.join(root, "Pioneer", "Logs", "evals");
  }
  const stateHome = environment.XDG_STATE_HOME;
  const root =
    stateHome !== undefined && pathApi.isAbsolute(stateHome)
      ? stateHome
      : pathApi.join(home, ".local", "state");
  return pathApi.join(root, "pioneer", "logs", "evals");
}

export function generatedDefaultEvalWorkLogPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  now = new Date(),
  id: string = randomUUID(),
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(id)) {
    throw new Error("Eval work log identifier is invalid");
  }
  const timestamp = now.toISOString().replaceAll(/[-:.]/g, "");
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    evalWorkLogDirectory(environment, platform, home),
    `eval-${timestamp}-${id}.jsonl`,
  );
}

export async function prepareDefaultEvalWorkLogDirectory(
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directory = pathApi.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink()) {
    throw new Error(`Eval work log directory is a symbolic link: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`Eval work log path is not a directory: ${directory}`);
  }
  if (platform !== "win32") await chmod(directory, 0o700);
}

function jsonSafe(value: unknown, key?: string): unknown {
  if (key !== undefined && isCredentialLabel(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeDiagnostic(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, key));
  return undefined;
}

function sanitizedDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const safe = jsonSafe(value, key);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

export function evalWorkLogCreateError(target: string, error: unknown): Error {
  return new Error(
    diagnosticMessage(
      "EVAL_WORK_LOG_CREATE_FAILED",
      `Pioneer could not create the eval work log at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}

export function evalWorkLogWriteError(target: string, error: unknown): Error {
  return new Error(
    diagnosticMessage(
      "EVAL_WORK_LOG_WRITE_FAILED",
      `Pioneer could not write the eval work log at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}

export function openEvalWorkLog(target: string, options: OpenEvalWorkLogOptions = {}): EvalWorkLog {
  const maxBytes = options.maxBytes ?? MAX_WORK_LOG_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_WORK_LOG_BYTES) {
    throw new Error(
      `Eval work log byte limit must be a safe integer of at least ${MIN_WORK_LOG_BYTES}`,
    );
  }
  const runId = options.runId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    throw new Error(
      "Eval work log run identifier must use 1 to 128 ASCII letters, digits, '.', '_', or '-'",
    );
  }
  const now = options.now ?? (() => new Date());
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    throw evalWorkLogCreateError(target, error);
  }
  let written = 0;
  let sequence = 0;
  let firstTimestamp: number | undefined;
  let closed = false;
  let truncated = false;

  const truncationError = (): Error =>
    evalWorkLogWriteError(target, new Error(`Eval work log exceeded ${maxBytes} bytes`));

  const append = (record: Record<string, unknown>, limit: number): boolean => {
    const line = `${JSON.stringify(record)}\n`;
    const buffer = Buffer.from(line);
    if (written + buffer.length > limit) return false;
    const bytesWritten = writeSync(descriptor, buffer, 0, buffer.length);
    if (bytesWritten !== buffer.length) {
      throw new Error(`Eval work log short write at ${target}`);
    }
    written += bytesWritten;
    fsyncSync(descriptor);
    return true;
  };

  return {
    path: target,
    runId,
    record(type, details = {}) {
      if (closed) throw evalWorkLogWriteError(target, new Error("Eval work log is closed"));
      if (truncated) throw truncationError();
      const timestamp = now();
      firstTimestamp ??= timestamp.getTime();
      sequence += 1;
      const record = {
        ...sanitizedDetails(details),
        schemaVersion: 1,
        timestamp: timestamp.toISOString(),
        elapsedMs: Math.max(0, timestamp.getTime() - firstTimestamp),
        runId,
        sequence,
        type,
      };
      if (append(record, Math.max(0, maxBytes - WORK_LOG_TRUNCATION_RESERVE_BYTES))) return;
      truncated = true;
      if (
        !append(
          {
            schemaVersion: 1,
            timestamp: timestamp.toISOString(),
            elapsedMs: Math.max(0, timestamp.getTime() - firstTimestamp),
            runId,
            sequence: sequence + 1,
            type: "work_log_truncated",
            maxBytes,
          },
          maxBytes,
        )
      ) {
        throw evalWorkLogWriteError(target, new Error("could not persist truncation marker"));
      }
      throw truncationError();
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (truncated) {
        try {
          lstatSync(target);
        } catch {
          // Close still succeeds after a truncation failure already thrown from record().
        }
      }
    },
  };
}
