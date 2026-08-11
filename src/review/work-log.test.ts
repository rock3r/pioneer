import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readdirSync, readFileSync, writeSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  openReviewWorkLog,
  prepareDefaultReviewWorkLogPath,
  prepareValidatedDefaultReviewWorkLogPath,
  reviewWorkLogDirectory,
  sanitizeWorkLogDiagnostic,
  summarizePiEvent,
} from "./work-log.js";

function processIdentityForTest(processId: number, platform: NodeJS.Platform): string {
  let rawIdentity: string;
  if (platform === "linux") {
    const processStat = readFileSync(`/proc/${processId}/stat`, "utf8");
    const commandEnd = processStat.lastIndexOf(")");
    const fields = processStat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    rawIdentity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } else if (platform === "darwin") {
    rawIdentity = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(processId)], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      shell: false,
    }).stdout.trim();
  } else {
    rawIdentity = String(Math.floor(performance.timeOrigin / 1_000));
  }
  return createHash("sha256").update(`${platform}:${rawIdentity}`).digest("hex");
}

describe("review work log", () => {
  it("uses a documented per-user log directory on every platform", () => {
    expect(reviewWorkLogDirectory({}, "darwin", "/Users/operator")).toBe(
      "/Users/operator/Library/Logs/Pioneer/reviews",
    );
    expect(reviewWorkLogDirectory({ XDG_STATE_HOME: "/state" }, "linux", "/home/operator")).toBe(
      "/state/pioneer/logs/reviews",
    );
    expect(reviewWorkLogDirectory({}, "linux", "/home/operator")).toBe(
      "/home/operator/.local/state/pioneer/logs/reviews",
    );
    expect(
      reviewWorkLogDirectory(
        { LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" },
        "win32",
        "C:\\Users\\operator",
      ),
    ).toBe("C:\\Users\\operator\\AppData\\Local\\Pioneer\\Logs\\reviews");
  });

  it("writes JSONL records that are visible before close with private POSIX mode", async () => {
    const target = path.join(
      tmpdir(),
      `pioneer-work-log-${process.pid}-${crypto.randomUUID()}.jsonl`,
    );
    const timestamps = [new Date("2026-08-11T10:00:00.000Z"), new Date("2026-08-11T10:00:01.000Z")];
    const log = await openReviewWorkLog(target, {
      runId: "run-1",
      now: () => timestamps.shift() ?? new Date("2026-08-11T10:00:02.000Z"),
    });

    log.record("review_started", {
      platform: "darwin",
      runId: "forged",
      sequence: 99,
      type: "forged",
      timestamp: "forged",
    });

    const records = (await readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-08-11T10:00:00.000Z",
        elapsedMs: 0,
        runId: "run-1",
        sequence: 1,
        type: "review_started",
        platform: "darwin",
      },
    ]);
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }

    log.close();
  });

  it("marks a bounded log as truncated instead of growing indefinitely", async () => {
    const target = path.join(
      tmpdir(),
      `pioneer-work-log-${process.pid}-${crypto.randomUUID()}.jsonl`,
    );
    const log = await openReviewWorkLog(target, { runId: "run-1", maxBytes: 1_024 });
    log.record("review_started", { detail: "small" });
    log.record("pi_event", { detail: "x".repeat(2_000) });
    log.record("pi_event", { detail: "ignored after truncation" });
    log.close();

    const records = (await readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(({ type }) => type)).toEqual(["review_started", "work_log_truncated"]);
    expect((await stat(target)).size).toBeLessThanOrEqual(1_024);
  });

  it("closes the descriptor even when the final sync fails", async () => {
    const target = path.join(
      tmpdir(),
      `pioneer-work-log-${process.pid}-${crypto.randomUUID()}.jsonl`,
    );
    let closeCalls = 0;
    const log = await openReviewWorkLog(target, {
      fileOperations: {
        sync() {
          throw new Error("sync failed");
        },
        close(descriptor) {
          closeCalls += 1;
          closeSync(descriptor);
        },
      },
    });

    expect(() => log.close()).toThrow(/sync failed/i);
    expect(closeCalls).toBe(1);
    expect(() => log.close()).not.toThrow();
    expect(closeCalls).toBe(1);
  });

  it("completes short writes before declaring a record persisted", async () => {
    const target = path.join(
      tmpdir(),
      `pioneer-work-log-short-write-${process.pid}-${crypto.randomUUID()}.jsonl`,
    );
    let writes = 0;
    const log = await openReviewWorkLog(target, {
      runId: "run-1",
      fileOperations: {
        write(descriptor, buffer, offset, length) {
          writes += 1;
          return writeSync(descriptor, buffer, offset, Math.min(length, 5));
        },
        sync() {},
        close: closeSync,
      },
    });

    log.record("review_started", { detail: "complete" });
    log.close();

    expect(writes).toBeGreaterThan(1);
    expect(JSON.parse((await readFile(target, "utf8")).trim())).toMatchObject({
      type: "review_started",
      detail: "complete",
    });
  });

  it("syncs dirty records after one second without waiting for another event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));
    const target = path.join(
      tmpdir(),
      `pioneer-work-log-periodic-sync-${process.pid}-${crypto.randomUUID()}.jsonl`,
    );
    let syncCalls = 0;
    const log = await openReviewWorkLog(target, {
      fileOperations: {
        sync() {
          syncCalls += 1;
        },
        close: closeSync,
      },
    });
    try {
      log.record("review_started");
      expect(syncCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      log.record("stage_started");
      expect(syncCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(900);
      expect(syncCalls).toBe(2);
    } finally {
      log.close();
      vi.useRealTimers();
    }
  });

  it("retains at most 100 auto-created review logs without touching other files", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-state-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory =
      platform === "darwin"
        ? path.join(home, "Library", "Logs", "Pioneer", "reviews")
        : platform === "win32"
          ? path.join(stateRoot, "Pioneer", "Logs", "reviews")
          : path.join(stateRoot, "pioneer", "logs", "reviews");
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            `review-20260801T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
          ),
          "old\n",
        ),
      ),
    );
    await writeFile(path.join(directory, "keep-me.txt"), "unrelated\n");
    await writeFile(path.join(directory, "review-custom.jsonl"), "custom\n");

    const target = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000101",
    );
    const log = await openReviewWorkLog(target, { retainDefaultLogs: true, platform });
    log.record("review_started");
    log.close();

    const entries = await readdir(directory);
    expect(entries.filter((entry) => /^review-\d{8}T/.test(entry))).toHaveLength(100);
    expect(entries).toContain("keep-me.txt");
    expect(entries).toContain("review-custom.jsonl");
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it("retains at most 100 default logs across sequentially prepared concurrent reviews", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-concurrent-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            `review-20260801T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
          ),
          "old\n",
        ),
      ),
    );
    const firstTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000101",
    );
    const secondTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.001Z"),
      "00000000-0000-0000-0000-000000000102",
    );

    const [first, second] = await Promise.all([
      openReviewWorkLog(firstTarget, { retainDefaultLogs: true, platform }),
      openReviewWorkLog(secondTarget, { retainDefaultLogs: true, platform }),
    ]);
    first.close();
    second.close();

    expect((await readdir(directory)).filter((entry) => /^review-\d{8}T/.test(entry))).toHaveLength(
      100,
    );
  });

  it("prunes the inactive pool after overlapping default logs finish", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-close-retention-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    const markerPaths = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const logPath = path.join(
          directory,
          `review-20260801T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
        );
        const markerPath = `${logPath}.active-${process.pid}-${String(index).padStart(32, "0")}`;
        await Promise.all([writeFile(logPath, "active\n"), writeFile(markerPath, "")]);
        return markerPath;
      }),
    );
    const nextTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-07-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000101",
    );
    const next = await openReviewWorkLog(nextTarget, { retainDefaultLogs: true, platform });
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(
      101,
    );

    await Promise.all(markerPaths.map(async (markerPath) => await unlink(markerPath)));
    next.close();

    expect((await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(
      100,
    );
    expect((await lstat(nextTarget)).isFile()).toBe(true);
  });

  it("finishes creation-time retention before yielding the event loop", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-creation-lock-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    const staleTarget = path.join(
      directory,
      "review-20260801T000000000Z-00000000-0000-0000-0000-000000000000.jsonl",
    );
    const staleMarker = `${staleTarget}.active-${process.pid}-11111111111111111111111111111111`;
    await Promise.all([writeFile(staleTarget, "completed\n"), writeFile(staleMarker, "")]);
    await utimes(
      staleMarker,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const nextTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000002",
    );

    const opening = openReviewWorkLog(nextTarget, { retainDefaultLogs: true, platform });

    expect(readdirSync(directory)).not.toContain(".pioneer-retention.lock");
    const next = await opening;

    next.close();
  });

  it("does not reclaim a stale-looking retention lock owned by a live process", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-live-lock-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, ".pioneer-retention.lock");
    await writeFile(
      lockPath,
      `${process.pid}:11111111111111111111111111111111:${processIdentityForTest(process.pid, platform)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await utimes(
      lockPath,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const target = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000004",
    );
    const owner = new Worker(
      `
        const { unlinkSync } = require("node:fs");
        const { workerData } = require("node:worker_threads");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, workerData.waitMs);
        unlinkSync(workerData.lockPath);
      `,
      { eval: true, workerData: { lockPath, waitMs: 200 } },
    );
    const ownerReleased = new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Retention lock owner exited with code ${code}`));
      });
    });
    const startedAt = Date.now();

    const log = await openReviewWorkLog(target, { retainDefaultLogs: true, platform });
    await ownerReleased;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    log.close();
  });

  it("reclaims an abandoned retention lock after its PID is reused", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-reused-lock-pid-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, ".pioneer-retention.lock");
    await writeFile(
      lockPath,
      `${process.pid}:22222222222222222222222222222222:${"0".repeat(64)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await utimes(
      lockPath,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const target = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000006",
    );

    const log = await openReviewWorkLog(target, { retainDefaultLogs: true, platform });

    log.close();
    expect((await lstat(target)).isFile()).toBe(true);
  }, 5_000);

  it("keeps renewing its active lease while waiting for close-time retention", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-close-lease-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    const target = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000003",
    );
    const log = await openReviewWorkLog(target, { retainDefaultLogs: true, platform });
    const marker = (await readdir(directory)).find((entry) =>
      entry.startsWith(`${path.basename(target)}.active-`),
    );
    expect(marker).toBeDefined();
    const markerPath = path.join(directory, marker ?? "missing");
    const lockPath = path.join(directory, ".pioneer-retention.lock");
    await writeFile(lockPath, "held\n", { flag: "wx", mode: 0o600 });
    const lockHolder = new Worker(
      `
          const { lstatSync, unlinkSync } = require("node:fs");
          const { workerData } = require("node:worker_threads");
          const wait = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(wait, 0, 0, workerData.waitMs);
          if (Date.now() - lstatSync(workerData.markerPath).mtimeMs >= workerData.staleMs) {
            unlinkSync(workerData.markerPath);
          }
          unlinkSync(workerData.lockPath);
        `,
      {
        eval: true,
        workerData: { lockPath, markerPath, staleMs: 5_000, waitMs: 5_500 },
      },
    );
    const lockReleased = new Promise<void>((resolve, reject) => {
      lockHolder.once("error", reject);
      lockHolder.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Retention lock-holder worker exited with code ${code}`));
      });
    });
    let closeFailure: unknown;

    try {
      log.close();
    } catch (error) {
      closeFailure = error;
    }
    await lockReleased;

    expect(closeFailure).toBeUndefined();
    expect((await lstat(target)).isFile()).toBe(true);
  }, 10_000);

  it("reclaims expired leases when an overlapping batch drains on close", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-close-stale-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    const target = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000005",
    );
    const log = await openReviewWorkLog(target, { retainDefaultLogs: true, platform });
    const staleMarkers = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const staleTarget = path.join(
          directory,
          `review-20260801T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
        );
        const staleMarker = `${staleTarget}.active-2147483647-${String(index).padStart(32, "0")}`;
        await Promise.all([writeFile(staleTarget, "crashed\n"), writeFile(staleMarker, "")]);
        return staleMarker;
      }),
    );
    await Promise.all(
      staleMarkers.map(async (marker) => {
        await utimes(
          marker,
          new Date("2026-08-01T00:00:00.000Z"),
          new Date("2026-08-01T00:00:00.000Z"),
        );
      }),
    );

    log.close();

    const entries = await readdir(directory);
    expect(entries.filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(100);
    expect(entries.some((entry) => entry.includes(".active-"))).toBe(false);
    expect((await lstat(target)).isFile()).toBe(true);
  });

  it("does not prune a default log that is still active", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-active-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const activeTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-01T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000001",
    );
    const active = await openReviewWorkLog(activeTarget, { retainDefaultLogs: true, platform });
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await Promise.all(
      Array.from({ length: 99 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            `review-20260802T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
          ),
          "completed\n",
        ),
      ),
    );
    const nextTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000002",
    );
    const next = await openReviewWorkLog(nextTarget, { retainDefaultLogs: true, platform });

    expect((await lstat(activeTarget)).isFile()).toBe(true);
    active.close();
    next.close();
  });

  it("revalidates a stale-looking lease that is renewed by its live owner", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-revalidate-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    const activeTarget = path.join(
      directory,
      "review-20260801T000000000Z-00000000-0000-0000-0000-000000000000.jsonl",
    );
    const activeMarker = `${activeTarget}.active-${process.pid}-11111111111111111111111111111111`;
    await Promise.all([
      writeFile(activeTarget, "active\n"),
      writeFile(activeMarker, ""),
      ...Array.from({ length: 99 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            `review-20260802T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
          ),
          "completed\n",
        ),
      ),
    ]);
    await utimes(
      activeMarker,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const leaseOwner = new Worker(
      `
        const { utimesSync } = require("node:fs");
        const { workerData } = require("node:worker_threads");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, workerData.waitMs);
        const now = new Date();
        utimesSync(workerData.markerPath, now, now);
      `,
      { eval: true, workerData: { markerPath: activeMarker, waitMs: 50 } },
    );
    const renewal = new Promise<void>((resolve, reject) => {
      leaseOwner.once("error", reject);
      leaseOwner.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Lease owner exited with code ${code}`));
      });
    });
    const nextTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000002",
    );
    const next = await openReviewWorkLog(nextTarget, { retainDefaultLogs: true, platform });
    await renewal;

    expect((await lstat(activeTarget)).isFile()).toBe(true);
    await unlink(activeMarker).catch(() => {});
    next.close();
  });

  it("removes a stale active marker and prunes its completed log", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-stale-active-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory = reviewWorkLogDirectory(environment, platform, home);
    await mkdir(directory, { recursive: true });
    const oldestTarget = path.join(
      directory,
      "review-20260801T000000000Z-00000000-0000-0000-0000-000000000000.jsonl",
    );
    await Promise.all([
      writeFile(oldestTarget, "completed\n"),
      writeFile(`${oldestTarget}.active`, ""),
      writeFile(`${oldestTarget}.active-2147483647`, ""),
      writeFile(`${oldestTarget}.active-${process.pid}`, ""),
      writeFile(`${oldestTarget}.active-00000000000000000000000000000000`, ""),
      writeFile(`${oldestTarget}.active-${process.pid}-22222222222222222222222222222222`, ""),
      ...Array.from({ length: 99 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            `review-20260802T000000000Z-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.jsonl`,
          ),
          "completed\n",
        ),
      ),
    ]);
    await utimes(
      `${oldestTarget}.active-00000000000000000000000000000000`,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    await utimes(
      oldestTarget,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    await utimes(
      `${oldestTarget}.active-${process.pid}-22222222222222222222222222222222`,
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const nextTarget = await prepareDefaultReviewWorkLogPath(
      environment,
      platform,
      home,
      new Date("2026-08-11T10:00:00.000Z"),
      "00000000-0000-0000-0000-000000000002",
    );
    const next = await openReviewWorkLog(nextTarget, { retainDefaultLogs: true, platform });
    next.close();

    const entries = await readdir(directory);
    expect(entries.filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(100);
    expect(entries).not.toContain(path.basename(oldestTarget));
    expect(entries).not.toContain(`${path.basename(oldestTarget)}.active`);
    expect(entries).not.toContain(`${path.basename(oldestTarget)}.active-2147483647`);
    expect(entries).not.toContain(`${path.basename(oldestTarget)}.active-${process.pid}`);
    expect(entries).not.toContain(
      `${path.basename(oldestTarget)}.active-00000000000000000000000000000000`,
    );
    expect(entries).not.toContain(
      `${path.basename(oldestTarget)}.active-${process.pid}-22222222222222222222222222222222`,
    );
  });

  it("rejects an unsafe generated log identifier", async () => {
    await expect(
      prepareDefaultReviewWorkLogPath(
        { XDG_STATE_HOME: tmpdir() },
        "linux",
        "/home/operator",
        new Date("2026-08-11T10:00:00.000Z"),
        "../escape",
      ),
    ).rejects.toThrow(/identifier/i);
  });

  it("validates a generated target before creating or pruning its directory", async () => {
    const stateRoot = path.join(
      tmpdir(),
      `pioneer-work-log-state-${process.pid}-${crypto.randomUUID()}`,
    );
    const platform = process.platform;
    const environment =
      platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
    const home = stateRoot;
    const directory =
      platform === "darwin"
        ? path.join(home, "Library", "Logs", "Pioneer", "reviews")
        : platform === "win32"
          ? path.join(stateRoot, "Pioneer", "Logs", "reviews")
          : path.join(stateRoot, "pioneer", "logs", "reviews");

    await expect(
      prepareValidatedDefaultReviewWorkLogPath(
        async () => {
          throw new Error("actor-visible target");
        },
        environment,
        platform,
        home,
      ),
    ).rejects.toThrow(/actor-visible/i);
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link default directory before pruning it",
    async () => {
      const stateRoot = path.join(
        tmpdir(),
        `pioneer-work-log-state-${process.pid}-${crypto.randomUUID()}`,
      );
      const external = path.join(
        tmpdir(),
        `pioneer-work-log-external-${process.pid}-${crypto.randomUUID()}`,
      );
      const parent = path.join(stateRoot, "pioneer", "logs");
      const retainedName = "review-20260801T000000000Z-00000000-0000-0000-0000-000000000000.jsonl";
      await Promise.all([mkdir(parent, { recursive: true }), mkdir(external)]);
      await writeFile(path.join(external, retainedName), "preserve\n");
      await symlink(external, path.join(parent, "reviews"));

      await expect(
        prepareDefaultReviewWorkLogPath({ XDG_STATE_HOME: stateRoot }, "linux", "/home/operator"),
      ).rejects.toThrow(/symbolic link/i);
      expect(await readFile(path.join(external, retainedName), "utf8")).toBe("preserve\n");
    },
  );

  it("redacts bounded provider diagnostics", () => {
    expect(
      sanitizeWorkLogDiagnostic(
        "Authorization: Bearer secret-token api_key=abc123 password=hunter2 failed",
      ),
    ).toBe("Authorization=[REDACTED] api_key=[REDACTED] password=[REDACTED] failed");
    expect(
      sanitizeWorkLogDiagnostic("provider echoed private prompt here", ["private prompt"]),
    ).toBe("provider echoed [REDACTED] here");
    expect(sanitizeWorkLogDiagnostic("x".repeat(800))).toHaveLength(500);
  });

  it("summarizes Pi events without prompt, model text, tool arguments, or tool output", () => {
    expect(
      summarizePiEvent({
        type: "tool_execution_start",
        toolCallId: `call-${"x".repeat(600)}`,
        toolName: "read token=secret-value",
        args: { path: "/secret/repository/file.ts" },
      }),
    ).toEqual({
      eventType: "tool_execution_start",
      toolCallIdHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      toolName: "unrecognized",
    });
    expect(
      summarizePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "private finding" },
      }),
    ).toEqual({
      eventType: "message_update",
      eventSubtype: "text_delta",
      deltaBytes: 15,
    });
    expect(
      ["start", "done", "error"].map((type) =>
        summarizePiEvent({
          type: "message_update",
          assistantMessageEvent: {
            type,
            reason: type === "error" ? "provider failure" : undefined,
            error: type === "error" ? { errorMessage: "private provider diagnostic" } : undefined,
          },
        }),
      ),
    ).toEqual([
      { eventType: "message_update", eventSubtype: "start" },
      { eventType: "message_update", eventSubtype: "done" },
      {
        eventType: "message_update",
        eventSubtype: "error",
        reasonPresent: true,
        reasonBytes: 16,
        diagnosticPresent: true,
        diagnosticBytes: 27,
      },
    ]);
    expect(
      summarizePiEvent(
        {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2_000,
          errorMessage: "Bearer secret provider overloaded after private prompt",
        },
        ["private prompt"],
      ),
    ).toEqual({
      eventType: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      diagnosticPresent: true,
      diagnosticBytes: 54,
    });
    expect(
      summarizePiEvent(
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "private prompt token=secret-value failed",
            content: "private model text",
          },
        },
        ["private prompt"],
      ),
    ).toEqual({
      eventType: "message_end",
      messageRole: "assistant",
      stopReason: "error",
      diagnosticPresent: true,
      diagnosticBytes: 40,
    });
    expect(
      JSON.stringify(
        summarizePiEvent(
          {
            type: "auto_retry_start",
            reason: "Project Falcon",
            errorMessage: "Project Falcon migration blocked",
          },
          ["Review confidential Project Falcon migration"],
        ),
      ),
    ).not.toContain("Project Falcon");
  });
});
