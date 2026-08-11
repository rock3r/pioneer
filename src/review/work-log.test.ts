import { closeSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    const log = await openReviewWorkLog(target);
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
      toolCallId: `call-${"x".repeat(495)}`,
      toolName: "read token=[REDACTED]",
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
      diagnostic: "Bearer [REDACTED] provider overloaded after [REDACTED]",
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
      diagnostic: "[REDACTED] token=[REDACTED] failed",
    });
  });
});
