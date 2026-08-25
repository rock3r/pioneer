import { randomUUID } from "node:crypto";
import { appendFile, chmod, writeFile } from "node:fs/promises";
import type { SafeDiagnosticV1 } from "./consensus.js";

export interface DeepReviewWorkLogRecord {
  readonly timestamp: string;
  readonly type: string;
  readonly elapsedMs: number;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DeepReviewWorkLog {
  readonly path: string;
  record(type: string, details?: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

const MAX_WORK_LOG_BYTES = 16 * 1024 * 1024;

export async function openDeepReviewWorkLog(path: string): Promise<DeepReviewWorkLog> {
  await writeFile(path, "", { encoding: "utf8", flag: "wx" });
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
  const startedAt = Date.now();
  let bytes = 0;
  let closed = false;
  let pendingWrite: Promise<void> = Promise.resolve();
  let writeError: Error | undefined;

  return {
    path,
    record(type, details = {}) {
      if (closed) return;
      if (writeError !== undefined) {
        throw new Error(
          `[DEEP_REVIEW_WORK_LOG_WRITE_FAILED] deep review work log write failed at ${path}`,
        );
      }
      const record: DeepReviewWorkLogRecord = {
        timestamp: new Date().toISOString(),
        type,
        elapsedMs: Date.now() - startedAt,
        details,
      };
      const line = `${JSON.stringify(record)}\n`;
      bytes += Buffer.byteLength(line, "utf8");
      if (bytes > MAX_WORK_LOG_BYTES) {
        throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] aggregate work log exceeds limit");
      }
      pendingWrite = pendingWrite
        .then(() => appendFile(path, line, "utf8"))
        .catch((error: unknown) => {
          writeError = error instanceof Error ? error : new Error(String(error));
        });
    },
    async close() {
      closed = true;
      await pendingWrite;
      if (writeError !== undefined) {
        throw new Error(
          `[DEEP_REVIEW_WORK_LOG_WRITE_FAILED] deep review work log write failed at ${path}`,
        );
      }
    },
  };
}

export function sanitizeAggregateDiagnostic(message: string): string {
  return message.replace(/\[[A-Z0-9_]+\]\s*/g, "").slice(0, 500);
}

export function diagnosticRecord(id: string, message: string): SafeDiagnosticV1 {
  return {
    id,
    severity: "error",
    message: `[${id}] ${sanitizeAggregateDiagnostic(message)}`,
  };
}

export function newRunId(): string {
  return randomUUID();
}
