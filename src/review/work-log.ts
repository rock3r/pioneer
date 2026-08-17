import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { sanitizeDiagnostic } from "../diagnostics.js";

const MAX_WORK_LOG_BYTES = 16 * 1024 * 1024;
const MIN_WORK_LOG_BYTES = 1_024;
const WORK_LOG_TRUNCATION_RESERVE_BYTES = 512;
const RETAINED_DEFAULT_WORK_LOGS = 100;
const WORK_LOG_SYNC_INTERVAL_MS = 1_000;
const ACTIVE_WORK_LOG_SUFFIX = ".active";
const ACTIVE_WORK_LOG_LEASE_MS = 5_000;
const ACTIVE_WORK_LOG_REVALIDATION_MS = WORK_LOG_SYNC_INTERVAL_MS + 100;
const RETENTION_LOCK_NAME = ".pioneer-retention.lock";
const RETENTION_LOCK_STALE_MS = 30_000;
const RETENTION_LOCK_WAIT_MS = 10;
const AUTO_WORK_LOG_NAME =
  /^review-\d{8}T\d{9}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;
const ACTIVE_WORK_LOG_NAME =
  /^(review-\d{8}T\d{9}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl)\.active(?:-([a-z0-9-]+))?$/i;
const RETENTION_LOCK_OWNER = /^(\d+):([0-9a-f]{32}):([0-9a-f]{64}(?:,[0-9a-f]{64}){0,4})\n$/i;
let currentProcessIdentityCache:
  | Readonly<{ identities: readonly string[]; platform: NodeJS.Platform }>
  | undefined;
const FILE_LEASE_WORKER = `
  const { utimesSync } = require("node:fs");
  const { workerData } = require("node:worker_threads");
  const control = new Int32Array(workerData.control);
  while (Atomics.load(control, 0) === 0) {
    const now = new Date();
    utimesSync(workerData.markerPath, now, now);
    Atomics.wait(control, 0, 0, workerData.intervalMs);
  }
`;
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
  "done",
  "error",
  "start",
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
const PI_DELTA_EVENT_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
const PI_TOOL_NAMES = new Set(["bash", "find", "grep", "ls", "read"]);
const PI_MESSAGE_ROLES = new Set(["assistant", "system", "tool", "user"]);
const PI_STOP_REASONS = new Set(["aborted", "error", "length", "stop", "toolUse"]);

export interface ReviewWorkLog {
  readonly path: string;
  readonly runId: string;
  record(type: string, details?: Readonly<Record<string, unknown>>): void;
  close(): void;
}

export class PiDeltaBatcher {
  private highVolumeCount = 0;
  private readonly batches = new Map<
    string,
    { eventType: string; eventSubtype: string; count: number; deltaBytes: number }
  >();
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly emit: (details: Readonly<Record<string, unknown>>) => void) {}

  public accept(event: Readonly<Record<string, unknown>>): void {
    if (
      event.eventType !== "message_update" ||
      typeof event.eventSubtype !== "string" ||
      !PI_DELTA_EVENT_TYPES.has(event.eventSubtype)
    ) {
      this.flush();
      this.emit(event);
      return;
    }
    if (this.highVolumeCount < 1_000) {
      this.highVolumeCount += 1;
      this.emit(event);
      return;
    }
    this.highVolumeCount += 1;
    const key = `${event.eventType}:${event.eventSubtype}`;
    const existing = this.batches.get(key) ?? {
      eventType: "message_update",
      eventSubtype: event.eventSubtype,
      count: 0,
      deltaBytes: 0,
    };
    existing.count += 1;
    existing.deltaBytes += typeof event.deltaBytes === "number" ? event.deltaBytes : 0;
    this.batches.set(key, existing);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), 5_000);
      this.timer.unref();
    }
  }

  public flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const batch of this.batches.values())
      this.emit({ type: "pi_event_delta_batch", ...batch });
    this.batches.clear();
  }
}

export interface OpenReviewWorkLogOptions {
  readonly runId?: string;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly retainDefaultLogs?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly fileOperations?: {
    readonly write?: (descriptor: number, buffer: Buffer, offset: number, length: number) => number;
    readonly sync: (descriptor: number) => void;
    readonly close: (descriptor: number) => void;
  };
}

export type ValidateReviewWorkLogTarget = (
  target: string,
  controllerMutationPaths: readonly string[],
) => Promise<void>;

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function hashProcessInstanceIdentity(platform: NodeJS.Platform, rawIdentity: string): string {
  return createHash("sha256").update(`${platform}:${rawIdentity}`).digest("hex");
}

export function buildWindowsProcessStartLookup(
  processId: number,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<{
  command: string;
  arguments: readonly string[];
  environment: NodeJS.ProcessEnv;
}> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Process ID must be a positive safe integer");
  }
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows system root must be an absolute path");
  }
  return {
    command: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    arguments: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[DateTimeOffset]::new((Get-Process -Id ([int]$env:PIONEER_RETENTION_OWNER_PID) -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()",
    ],
    environment: { ...environment, PIONEER_RETENTION_OWNER_PID: String(processId) },
  };
}

export function windowsProcessInstanceIdentities(
  processId: number,
  environment: NodeJS.ProcessEnv = process.env,
  runLookup: (
    lookup: ReturnType<typeof buildWindowsProcessStartLookup>,
  ) => Readonly<{ status: number | null; stdout: string }> = (lookup) => {
    const result = spawnSync(lookup.command, [...lookup.arguments], {
      encoding: "utf8",
      env: lookup.environment,
      shell: false,
      windowsHide: true,
    });
    return { status: result.status, stdout: result.stdout };
  },
): readonly string[] | undefined {
  const lookup = buildWindowsProcessStartLookup(processId, environment);
  const result = runLookup(lookup);
  if (result.status !== 0) return undefined;
  const startTimeMilliseconds = Number(result.stdout.trim());
  if (!Number.isSafeInteger(startTimeMilliseconds) || startTimeMilliseconds <= 0) return undefined;
  return [-2, -1, 0, 1, 2].map((offset) =>
    hashProcessInstanceIdentity("win32", String(startTimeMilliseconds + offset)),
  );
}

export function processInstanceIdentities(
  processId: number,
  platform: NodeJS.Platform,
): readonly string[] | undefined {
  let rawIdentity: string | undefined;
  try {
    if (platform === "linux") {
      const processStat = readFileSync(`/proc/${processId}/stat`, "utf8");
      const commandEnd = processStat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const fields = processStat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/);
      const startTimeTicks = fields[19];
      if (startTimeTicks === undefined || !/^\d+$/.test(startTimeTicks)) return undefined;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      rawIdentity = `${bootId}:${startTimeTicks}`;
    } else if (platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(processId)], {
        encoding: "utf8",
        env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
        shell: false,
      });
      if (result.status !== 0) return undefined;
      rawIdentity = result.stdout.trim();
    } else if (platform === "win32") {
      return windowsProcessInstanceIdentities(processId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (rawIdentity === undefined || rawIdentity.length === 0) return undefined;
  return [hashProcessInstanceIdentity(platform, rawIdentity)];
}

export function currentProcessInstanceIdentities(
  platform: NodeJS.Platform,
): readonly string[] | undefined {
  if (currentProcessIdentityCache?.platform === platform) {
    return currentProcessIdentityCache.identities;
  }
  const identities = processInstanceIdentities(process.pid, platform);
  if (identities !== undefined) currentProcessIdentityCache = { identities, platform };
  return identities;
}

function activeLeaseIsFresh(modifiedAtMs: number): boolean {
  const leaseAgeMs = Date.now() - modifiedAtMs;
  return leaseAgeMs >= -ACTIVE_WORK_LOG_LEASE_MS && leaseAgeMs <= ACTIVE_WORK_LOG_LEASE_MS;
}

export function classifyStaleActiveLeaseOwner(
  ownerIdentity: string,
  currentIdentities: readonly string[] | undefined,
): "protect" | "reclaim" | "revalidate" {
  if (currentIdentities === undefined) return "revalidate";
  return currentIdentities.includes(ownerIdentity) ? "protect" : "reclaim";
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
}

function acquireDefaultWorkLogRetentionLock(target: string, platform: NodeJS.Platform): () => void {
  const pathApi = platformPath(platform);
  const lockPath = pathApi.join(pathApi.dirname(target), RETENTION_LOCK_NAME);
  const deadline = Date.now() + RETENTION_LOCK_STALE_MS;
  const waitControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (true) {
    const release = tryCreateRetentionLock(lockPath, platform);
    if (release !== undefined) return release;
    if (reclaimAbandonedRetentionLock(lockPath, platform)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for review work-log retention lock: ${lockPath}`);
    }
    Atomics.wait(waitControl, 0, 0, RETENTION_LOCK_WAIT_MS);
  }
}

function tryCreateRetentionLock(
  lockPath: string,
  platform: NodeJS.Platform,
): (() => void) | undefined {
  const ownerToken = crypto.randomUUID().replaceAll("-", "");
  const instanceIdentities = currentProcessInstanceIdentities(platform);
  if (instanceIdentities === undefined) {
    throw new Error(`Could not determine review work-log retention owner identity: ${process.pid}`);
  }
  const owner = `${process.pid}:${ownerToken}:${instanceIdentities.join(",")}\n`;
  const ownerPath = `${lockPath}.owner-${process.pid}-${ownerToken}`;
  writeFileSync(ownerPath, owner, { flag: "wx", flush: true, mode: 0o600 });
  let linked = false;
  let failure: unknown;
  try {
    linkSync(ownerPath, lockPath);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") failure = error;
  }
  try {
    unlinkSync(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
  }
  if (failure !== undefined) {
    if (linked) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the owner-publication or temporary-file cleanup failure.
      }
    }
    throw failure;
  }
  if (!linked) return undefined;
  return retentionLockRelease(lockPath, owner);
}

function reclaimAbandonedRetentionLock(lockPath: string, platform: NodeJS.Platform): boolean {
  try {
    if (Date.now() - lstatSync(lockPath).mtimeMs < RETENTION_LOCK_STALE_MS) return false;
    const owner = readFileSync(lockPath, "utf8");
    const match = RETENTION_LOCK_OWNER.exec(owner);
    const processId = Number(match?.[1]);
    if (!Number.isSafeInteger(processId) || processId <= 0) return false;
    if (processIsAlive(processId)) {
      const currentIdentities = processInstanceIdentities(processId, platform);
      const ownerIdentities = new Set(match?.[3]?.split(",") ?? []);
      if (
        currentIdentities === undefined ||
        currentIdentities.some((identity) => ownerIdentities.has(identity))
      ) {
        return false;
      }
    }
    if (readFileSync(lockPath, "utf8") !== owner) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function retentionLockRelease(lockPath: string, owner: string): () => void {
  return () => {
    try {
      if (readFileSync(lockPath, "utf8") !== owner) {
        throw new Error(`Review work-log retention lock ownership changed: ${lockPath}`);
      }
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Review work-log retention lock disappeared: ${lockPath}`, {
          cause: error,
        });
      }
      throw error;
    }
  };
}

function withDefaultWorkLogRetentionLock(
  target: string,
  platform: NodeJS.Platform,
  operation: () => void,
): void {
  const release = acquireDefaultWorkLogRetentionLock(target, platform);
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  try {
    release();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function pruneInactiveDefaultReviewWorkLogsSync(target: string, platform: NodeJS.Platform): void {
  const pathApi = platformPath(platform);
  const directory = pathApi.dirname(target);
  const targetName = pathApi.basename(target);
  if (!AUTO_WORK_LOG_NAME.test(targetName)) {
    throw new Error(`Review work log target is not an auto-created log: ${target}`);
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  const activeLogs = new Set<string>();
  const staleMarkers: string[] = [];
  const revalidationCandidates: Array<{
    logName: string;
    markerPath: string;
    modifiedAtMs: number;
  }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = ACTIVE_WORK_LOG_NAME.exec(entry.name);
    if (match === null) continue;
    const markerPath = pathApi.join(directory, entry.name);
    const markedLogName = match[1];
    const owner = /^(\d+)-([0-9a-f]{32})$/i.exec(match[2] ?? "");
    if (owner !== null && markedLogName !== undefined) {
      try {
        const markerStats = lstatSync(markerPath);
        if (activeLeaseIsFresh(markerStats.mtimeMs)) {
          activeLogs.add(markedLogName);
          continue;
        }
        const processId = Number(owner[1]);
        if (Number.isSafeInteger(processId) && processId > 0 && processIsAlive(processId)) {
          const ownerIdentity = /^([0-9a-f]{64})\n$/i.exec(readFileSync(markerPath, "utf8"))?.[1];
          if (ownerIdentity !== undefined) {
            const currentIdentities = processInstanceIdentities(processId, platform);
            const ownerStatus = classifyStaleActiveLeaseOwner(ownerIdentity, currentIdentities);
            if (ownerStatus === "protect") {
              activeLogs.add(markedLogName);
              continue;
            }
            if (ownerStatus === "reclaim") {
              staleMarkers.push(markerPath);
              continue;
            }
          }
          revalidationCandidates.push({
            logName: markedLogName,
            markerPath,
            modifiedAtMs: markerStats.mtimeMs,
          });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
    }
    staleMarkers.push(markerPath);
  }
  if (revalidationCandidates.length > 0) {
    const waitControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(waitControl, 0, 0, ACTIVE_WORK_LOG_REVALIDATION_MS);
    for (const candidate of revalidationCandidates) {
      try {
        const refreshedStats = lstatSync(candidate.markerPath);
        if (
          refreshedStats.mtimeMs !== candidate.modifiedAtMs &&
          activeLeaseIsFresh(refreshedStats.mtimeMs)
        ) {
          activeLogs.add(candidate.logName);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      staleMarkers.push(candidate.markerPath);
    }
  }
  for (const markerPath of staleMarkers) {
    try {
      unlinkSync(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const existingLogs: Array<{ modifiedAtMs: number; name: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !AUTO_WORK_LOG_NAME.test(entry.name)) continue;
    try {
      existingLogs.push({
        modifiedAtMs: lstatSync(pathApi.join(directory, entry.name)).mtimeMs,
        name: entry.name,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const existingLogNames = existingLogs
    .sort(
      (left, right) =>
        left.modifiedAtMs - right.modifiedAtMs || left.name.localeCompare(right.name),
    )
    .map(({ name }) => name);
  const removeCount = Math.max(0, existingLogNames.length - RETAINED_DEFAULT_WORK_LOGS);
  const removableLogs = existingLogNames.filter(
    (name) => name !== targetName && !activeLogs.has(name),
  );
  for (const name of removableLogs.slice(0, removeCount)) {
    try {
      unlinkSync(pathApi.join(directory, name));
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
  await validateTarget(target, [platformPath(platform).dirname(target)]);
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
  return sanitizeDiagnostic(value, secrets);
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
    const reason = stringField(typed, "reason");
    const error = typed.error;
    const diagnostic =
      typeof error === "object" && error !== null
        ? stringField(error as Record<string, unknown>, "errorMessage")
        : undefined;
    return definedFields({
      ...base,
      eventSubtype: allowlistedStringField(typed, "type", PI_MESSAGE_UPDATE_TYPES),
      contentIndex: numberField(typed, "contentIndex"),
      deltaBytes: delta === undefined ? undefined : Buffer.byteLength(delta),
      reasonPresent: reason === undefined ? undefined : true,
      reasonBytes: reason === undefined ? undefined : Buffer.byteLength(reason),
      diagnosticPresent: diagnostic === undefined ? undefined : true,
      diagnosticBytes: diagnostic === undefined ? undefined : Buffer.byteLength(diagnostic),
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
  const platform = options.platform ?? process.platform;
  const maxBytes = options.maxBytes ?? MAX_WORK_LOG_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_WORK_LOG_BYTES) {
    throw new Error(
      `Review work log byte limit must be a safe integer of at least ${MIN_WORK_LOG_BYTES}`,
    );
  }
  const runId = options.runId ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    throw new Error(
      "Review work log run identifier must use 1 to 128 ASCII letters, digits, '.', '_', or '-'",
    );
  }
  const ownerToken =
    options.retainDefaultLogs === true ? crypto.randomUUID().replaceAll("-", "") : undefined;
  const activeOwnerIdentities =
    options.retainDefaultLogs === true ? currentProcessInstanceIdentities(platform) : undefined;
  if (options.retainDefaultLogs === true && activeOwnerIdentities === undefined) {
    throw new Error(`Could not determine review work-log owner identity: ${process.pid}`);
  }
  const activeOwnerIdentity = activeOwnerIdentities?.[Math.floor(activeOwnerIdentities.length / 2)];
  const activeMarker =
    options.retainDefaultLogs === true &&
    ownerToken !== undefined &&
    activeOwnerIdentity !== undefined
      ? `${target}${ACTIVE_WORK_LOG_SUFFIX}-${process.pid}-${ownerToken}`
      : undefined;
  let markerLeaseWorker: Worker | undefined;
  let markerLeaseControl: Int32Array | undefined;
  let markerLeaseFailure: unknown;
  let markerLeaseStopped = false;
  const stopMarkerLease = (): void => {
    markerLeaseStopped = true;
    if (markerLeaseControl !== undefined) {
      Atomics.store(markerLeaseControl, 0, 1);
      Atomics.notify(markerLeaseControl, 0);
    }
    if (markerLeaseWorker !== undefined) {
      void markerLeaseWorker.terminate().catch(() => {});
    }
  };
  if (activeMarker !== undefined) {
    try {
      writeFileSync(activeMarker, `${activeOwnerIdentity}\n`, {
        flag: "wx",
        flush: true,
        mode: 0o600,
      });
      markerLeaseControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      markerLeaseWorker = new Worker(FILE_LEASE_WORKER, {
        eval: true,
        workerData: {
          control: markerLeaseControl.buffer,
          intervalMs: WORK_LOG_SYNC_INTERVAL_MS,
          markerPath: activeMarker,
        },
      });
      markerLeaseWorker.on("error", (error) => {
        if (!markerLeaseStopped) markerLeaseFailure ??= error;
      });
      markerLeaseWorker.on("exit", (code) => {
        if (!markerLeaseStopped) {
          markerLeaseFailure ??= new Error(
            `Review work-log marker lease stopped with code ${code}`,
          );
        }
      });
      markerLeaseWorker.unref();
    } catch (error) {
      stopMarkerLease();
      try {
        unlinkSync(activeMarker);
      } catch {
        // Preserve the marker close failure.
      }
      throw error;
    }
  }
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    stopMarkerLease();
    if (activeMarker !== undefined) {
      try {
        unlinkSync(activeMarker);
      } catch {
        // Preserve the create-only target failure.
      }
    }
    throw error;
  }
  const closeDescriptor = options.fileOperations?.close ?? closeSync;
  if (options.retainDefaultLogs === true) {
    try {
      withDefaultWorkLogRetentionLock(target, platform, () => {
        pruneInactiveDefaultReviewWorkLogsSync(target, platform);
      });
    } catch (error) {
      stopMarkerLease();
      try {
        closeDescriptor(descriptor);
      } catch {
        // Preserve the retention failure that prevented the log from opening.
      }
      try {
        await unlink(target);
      } catch {
        // Best-effort rollback; preserve the retention failure.
      }
      if (activeMarker !== undefined) {
        try {
          unlinkSync(activeMarker);
        } catch {
          // Best-effort rollback; preserve the retention failure.
        }
      }
      throw error;
    }
  }
  const now = options.now ?? (() => new Date());
  const writeDescriptor =
    options.fileOperations?.write ??
    ((fileDescriptor: number, buffer: Buffer, offset: number, length: number) =>
      writeSync(fileDescriptor, buffer, offset, length));
  const syncDescriptor = options.fileOperations?.sync ?? fsyncSync;
  let sequence = 0;
  let bytesWritten = 0;
  let firstTimestamp: number | undefined;
  let lastSyncAt: number | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  let syncFailure: unknown;
  let dirty = false;
  let closed = false;
  let truncated = false;
  const truncationError = (): Error =>
    new Error(`Review work log reached its ${maxBytes}-byte limit: ${target}`);

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

  const syncNow = (): void => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    syncDescriptor(descriptor);
    dirty = false;
    lastSyncAt = Date.now();
  };

  const syncOrSchedule = (): void => {
    if (syncFailure !== undefined) throw syncFailure;
    dirty = true;
    const currentTime = Date.now();
    if (lastSyncAt === undefined || currentTime - lastSyncAt >= WORK_LOG_SYNC_INTERVAL_MS) {
      syncNow();
      return;
    }
    if (syncTimer !== undefined) return;
    syncTimer = setTimeout(
      () => {
        syncTimer = undefined;
        if (closed || !dirty) return;
        try {
          syncDescriptor(descriptor);
          dirty = false;
          lastSyncAt = Date.now();
        } catch (error) {
          syncFailure = error;
        }
      },
      Math.max(0, WORK_LOG_SYNC_INTERVAL_MS - (currentTime - lastSyncAt)),
    );
    syncTimer.unref();
  };

  const syncOnClose = (): void => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    if (syncFailure !== undefined) throw syncFailure;
    try {
      syncDescriptor(descriptor);
    } finally {
      dirty = false;
    }
  };

  return {
    path: target,
    runId,
    record(type, details = {}) {
      if (closed) throw new Error(`Review work log is closed: ${target}`);
      if (markerLeaseFailure !== undefined) throw markerLeaseFailure;
      if (syncFailure !== undefined) throw syncFailure;
      if (truncated) throw truncationError();
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
        syncOrSchedule();
        return;
      }
      truncated = true;
      if (
        !append({
          ...base,
          type: "work_log_truncated",
          maxBytes,
        })
      ) {
        throw new Error(`Review work log could not persist its truncation marker: ${target}`);
      }
      syncOrSchedule();
      throw truncationError();
    },
    close() {
      if (closed) return;
      closed = true;
      let failure: unknown = markerLeaseFailure;
      try {
        syncOnClose();
      } catch (error) {
        failure ??= error;
      }
      try {
        closeDescriptor(descriptor);
      } catch (error) {
        failure ??= error;
      }
      if (activeMarker !== undefined) {
        try {
          withDefaultWorkLogRetentionLock(target, platform, () => {
            stopMarkerLease();
            failure ??= markerLeaseFailure;
            try {
              unlinkSync(activeMarker);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            pruneInactiveDefaultReviewWorkLogsSync(target, platform);
          });
        } catch (error) {
          stopMarkerLease();
          failure ??= markerLeaseFailure;
          failure ??= error;
          try {
            unlinkSync(activeMarker);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
              failure ??= cleanupError;
            }
          }
        }
      } else {
        stopMarkerLease();
      }
      if (failure !== undefined) throw failure;
    },
  };
}
