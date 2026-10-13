import { chmod, readFile, unlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import {
  createActorWarningCollector,
  type DeepReviewWorkLog,
  openDeepReviewWorkLog,
} from "./work-log.js";

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

  it.skipIf(process.platform === "win32")(
    "surfaces append failures at close instead of silently dropping records",
    async () => {
      const logPath = reserveTempPath(`deep-review-work-log-fail-${Date.now()}.jsonl`);
      const workLog = await openDeepReviewWorkLog(logPath);
      workLog.record("worker_started", { memberId: "worker-a" });
      await new Promise((resolve) => setImmediate(resolve));
      await chmod(logPath, 0o000);
      await new Promise((resolve) => setImmediate(resolve));

      let failure: unknown;
      try {
        workLog.record("worker_completed", { memberId: "worker-a" });
        await new Promise((resolve) => setImmediate(resolve));
        await workLog.close();
      } catch (error) {
        failure = error;
      }

      expect(String(failure)).toMatch(/DEEP_REVIEW_WORK_LOG_WRITE_FAILED/);
      await chmod(logPath, 0o600);
      await unlink(logPath);
    },
  );
});

describe("deep-review actor warnings", () => {
  it("records each distinct member warning once and returns it as a warning diagnostic", () => {
    const records: [string, unknown][] = [];
    const collector = createActorWarningCollector({
      path: "/unused",
      record: (type: string, details?: unknown) => records.push([type, details]),
      close: async () => undefined,
    } as unknown as DeepReviewWorkLog);
    const warning =
      "[PI_EXTENSION_SUBPROCESS_DENIED] Extension pi-subagents tried to start a subprocess, which the sandbox denies. Pioneer kept Pi running; extension features that need subprocesses are unavailable.";
    collector.onActorWarning("worker-a", warning);
    collector.onActorWarning("worker-a", warning);
    collector.onActorWarning("president", warning);
    expect(collector.diagnostics()).toEqual([
      {
        id: "pi-extension-subprocess-denied",
        severity: "warning",
        message: `${warning} Council member: worker-a.`,
      },
      {
        id: "pi-extension-subprocess-denied",
        severity: "warning",
        message: `${warning} Council member: president.`,
      },
    ]);
    expect(records).toEqual([
      ["actor_warning", { memberId: "worker-a", diagnosticCode: "PI_EXTENSION_SUBPROCESS_DENIED" }],
      [
        "actor_warning",
        { memberId: "president", diagnosticCode: "PI_EXTENSION_SUBPROCESS_DENIED" },
      ],
    ]);
  });
});
