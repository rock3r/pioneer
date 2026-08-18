import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evalWorkLogDirectory,
  generatedDefaultEvalWorkLogPath,
  openEvalWorkLog,
  prepareDefaultEvalWorkLogDirectory,
} from "./work-log.js";

describe("eval work log", () => {
  const createdRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("places default logs in the platform Pioneer evals directory", () => {
    expect(evalWorkLogDirectory({}, "darwin", "/Users/operator")).toBe(
      "/Users/operator/Library/Logs/Pioneer/evals",
    );
    expect(evalWorkLogDirectory({ XDG_STATE_HOME: "/var/state" }, "linux", "/home/operator")).toBe(
      "/var/state/pioneer/logs/evals",
    );
    expect(
      evalWorkLogDirectory(
        { LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local" },
        "win32",
        "C:\\Users\\op",
      ),
    ).toBe("C:\\Users\\op\\AppData\\Local\\Pioneer\\Logs\\evals");
  });

  it("creates a unique default eval work-log name", () => {
    const target = generatedDefaultEvalWorkLogPath(
      {},
      "darwin",
      "/Users/operator",
      new Date("2026-08-18T12:00:00.000Z"),
      "abcd1234-ef56-7890-abcd-ef1234567890",
    );
    expect(target).toBe(
      "/Users/operator/Library/Logs/Pioneer/evals/eval-20260818T120000000Z-abcd1234-ef56-7890-abcd-ef1234567890.jsonl",
    );
  });

  it("writes schema-versioned stage records and redacts secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-eval-work-log-"));
    createdRoots.push(root);
    const target = path.join(root, "eval.jsonl");
    const log = openEvalWorkLog(target, {
      runId: "run-1",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });
    log.record("eval_started", { platform: "darwin" });
    log.record("stage_started", { stage: "pi_home_snapshot", token: "secret-token-value" });
    log.close();

    const records = (await readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      type: "eval_started",
      runId: "run-1",
      sequence: 1,
      platform: "darwin",
    });
    expect(records[1]?.stage).toBe("pi_home_snapshot");
    expect(JSON.stringify(records[1])).not.toContain("secret-token-value");
  });

  it("fails closed when the target already exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-eval-work-log-"));
    createdRoots.push(root);
    const target = path.join(root, "eval.jsonl");
    await writeFile(target, "existing\n");
    expect(() => openEvalWorkLog(target)).toThrow("[EVAL_WORK_LOG_CREATE_FAILED]");
  });

  it("fails closed after writing a truncation marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-eval-work-log-"));
    createdRoots.push(root);
    const target = path.join(root, "eval.jsonl");
    const log = openEvalWorkLog(target, { runId: "run-1", maxBytes: 1_024 });
    expect(() => {
      log.record("eval_started", { payload: "x".repeat(2_000) });
    }).toThrow("[EVAL_WORK_LOG_WRITE_FAILED]");
    log.close();
    const contents = await readFile(target, "utf8");
    expect(contents).toContain("work_log_truncated");
  });

  it("creates the default directory with owner-only mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-eval-work-log-dir-"));
    createdRoots.push(root);
    const target = path.join(root, "evals", "eval.jsonl");
    await prepareDefaultEvalWorkLogDirectory(target);
    const { stat } = await import("node:fs/promises");
    const details = await stat(path.dirname(target));
    expect(details.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(details.mode & 0o777).toBe(0o700);
    }
  });
});
