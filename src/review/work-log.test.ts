import { closeSync, writeSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  openReviewWorkLog,
  prepareDefaultReviewWorkLogPath,
  prepareValidatedDefaultReviewWorkLogPath,
  reviewWorkLogDirectory,
  sanitizeWorkLogDiagnostic,
  summarizePiEvent,
} from "./work-log.js";

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
