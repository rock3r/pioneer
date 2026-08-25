import { chmod, readFile, unlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { openDeepReviewWorkLog } from "./work-log.js";

describe("deep review work log", () => {
  const { reserveTempPath } = registerManagedTempPaths();

  it("flushes pending records before close returns", async () => {
    const path = reserveTempPath(`deep-review-work-log-${Date.now()}.jsonl`);
    const workLog = await openDeepReviewWorkLog(path);
    workLog.record("worker_started", { memberId: "worker-a" });
    workLog.record("worker_completed", { memberId: "worker-a" });
    await workLog.close();

    const contents = await readFile(path, "utf8");
    expect(contents).toContain('"type":"worker_started"');
    expect(contents).toContain('"type":"worker_completed"');
  });

  it("surfaces append failures at close instead of silently dropping records", async () => {
    const logPath = reserveTempPath(`deep-review-work-log-fail-${Date.now()}.jsonl`);
    const workLog = await openDeepReviewWorkLog(logPath);
    workLog.record("worker_started", { memberId: "worker-a" });
    await new Promise((resolve) => setImmediate(resolve));
    await chmod(logPath, 0o000);
    workLog.record("worker_completed", { memberId: "worker-a" });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(workLog.close()).rejects.toThrow(/DEEP_REVIEW_WORK_LOG_WRITE_FAILED/);
    await chmod(logPath, 0o600);
    await unlink(logPath);
  });
});
