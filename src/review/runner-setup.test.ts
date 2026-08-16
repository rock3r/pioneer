import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserveReviewReport: vi.fn(),
}));

vi.mock("./report-output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./report-output.js")>()),
  reserveReviewReport: mocks.reserveReviewReport,
}));

import { runReview } from "./runner.js";

describe("review setup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    mocks.reserveReviewReport.mockReset();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("announces the work log before report reservation can fail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-setup-"));
    roots.push(root);
    const sourceDir = path.join(root, "source");
    const piHomeSource = path.join(root, "pi-home");
    const outputDir = path.join(root, "outputs");
    await Promise.all([mkdir(sourceDir), mkdir(piHomeSource), mkdir(outputDir)]);
    const workLogPath = path.join(outputDir, "review.jsonl");
    const reportPath = path.join(outputDir, "report.md");
    const announced: string[] = [];
    mocks.reserveReviewReport.mockRejectedValueOnce(new Error("reservation failed"));

    await expect(
      runReview({
        sourceDir,
        prompt: "Review the source.",
        piHomeSource,
        reportPath,
        workLogPath,
        resumable: false,
        allowUnsandboxedWindows: true,
        onWorkLogReady: (readyPath) => announced.push(readyPath),
      }),
    ).rejects.toThrow("[REVIEW_REPORT_CREATE_FAILED]");

    expect(announced).toEqual([await realpath(workLogPath)]);
    expect(await readFile(workLogPath, "utf8")).toContain('"type":"review_failed"');
  });
});
