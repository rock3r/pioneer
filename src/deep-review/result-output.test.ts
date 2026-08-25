import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { releaseReviewReportReservation, reserveReviewReport } from "../review/report-output.js";
import { type DeepReviewResultV1, persistDeepReviewResult } from "./result-output.js";

function sampleResult(): DeepReviewResultV1 {
  return {
    schemaVersion: "pioneer-deep-review-result/v1",
    runId: "00000000-0000-4000-8000-000000000001",
    repository: { owner: "acme", name: "repo" },
    pullRequest: { number: 1 },
    packetDigest: "a".repeat(64),
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    status: "complete",
    verdict: "clean",
    workers: [],
    president: {
      memberId: "president",
      model: "provider/model",
      status: "success",
      clusterCount: 0,
    },
    publishableFindings: [],
    artifactFindings: [],
    diagnostics: [],
  };
}

describe("deep review result output", () => {
  const { createTempDir } = registerManagedTempPaths();

  it("does not overwrite a result target replaced after reservation", async () => {
    const root = await createTempDir("pioneer-deep-review-result-");
    const target = path.join(root, "result.json");
    const reservation = await reserveReviewReport(target);

    try {
      await rm(target);
      await writeFile(target, "replacement\n");

      await expect(
        persistDeepReviewResult({
          result: sampleResult(),
          resultPath: target,
          reservation,
        }),
      ).rejects.toThrow(/reservation/i);

      expect(await readFile(target, "utf8")).toBe("replacement\n");
    } finally {
      await releaseReviewReportReservation(reservation).catch(() => {});
    }
  });

  it("persists through a reserved target inode", async () => {
    const root = await createTempDir("pioneer-deep-review-result-");
    const target = path.join(root, "result.json");
    const reservation = await reserveReviewReport(target);
    const result = sampleResult();

    await persistDeepReviewResult({ result, resultPath: target, reservation });

    const persisted = JSON.parse(await readFile(target, "utf8")) as DeepReviewResultV1;
    expect(persisted.runId).toBe(result.runId);
  });
});
