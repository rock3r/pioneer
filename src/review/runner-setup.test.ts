import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPiReady: vi.fn(),
  reserveReviewReport: vi.fn(),
}));

vi.mock("../pi-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi-readiness.js")>()),
  assertPiReady: mocks.assertPiReady,
}));

vi.mock("./report-output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./report-output.js")>()),
  reserveReviewReport: mocks.reserveReviewReport,
}));

import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { runReview } from "./runner.js";

const { createTempDir } = registerManagedTempPaths();

describe("review setup", () => {
  afterEach(async () => {
    mocks.assertPiReady.mockReset();
    mocks.reserveReviewReport.mockReset();
  });

  // The controller scratch base is validated with the other request scalars, before any
  // controller output exists, so a bad base cannot be discovered halfway through a run.
  it("rejects an unusable controller scratch base before creating any output", async () => {
    const root = await createTempDir("pioneer-review-scratch-base-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir);

    await expect(
      runReview({
        sourceDir,
        prompt: "Review source",
        controllerScratchBase: path.join(root, "absent"),
        ...(process.platform === "win32" ? { allowUnsandboxedWindows: true } : {}),
      }),
    ).rejects.toThrow(/controller scratch base/i);
  });

  // Creating and deleting `pir-*` inside a granted path would write through a mount the actor
  // is promised read-only, and hand the sandbox overlapping read-only and writable paths.
  it("rejects a controller scratch base inside a granted path", async () => {
    const root = await createTempDir("pioneer-review-scratch-base-");
    const sourceDir = path.join(root, "source");
    const inside = path.join(sourceDir, "scratch");
    await mkdir(sourceDir);
    await mkdir(inside);

    await expect(
      runReview({
        sourceDir,
        prompt: "Review source",
        controllerScratchBase: inside,
        ...(process.platform === "win32" ? { allowUnsandboxedWindows: true } : {}),
      }),
    ).rejects.toThrow(/scratch base.*(granted|inside)/i);
  });

  it("allows a controller scratch base that merely shares an ancestor with a grant", async () => {
    const root = await createTempDir("pioneer-review-scratch-base-");
    const sourceDir = path.join(root, "source");
    const sibling = path.join(root, "scratch");
    const piHomeSource = path.join(root, "pi-home");
    await Promise.all([mkdir(sourceDir), mkdir(sibling), mkdir(piHomeSource)]);

    mocks.assertPiReady.mockRejectedValueOnce(new Error("readiness reached"));

    // Continue past scratch-base validation, then stop at the mocked readiness boundary so
    // this unit test never depends on the host Pi installation or contacts a provider.
    await expect(
      runReview({
        sourceDir,
        prompt: "Review source",
        piHomeSource,
        controllerScratchBase: sibling,
        ...(process.platform === "win32" ? { allowUnsandboxedWindows: true } : {}),
      }),
    ).rejects.toThrow("readiness reached");
    expect(mocks.assertPiReady).toHaveBeenCalledOnce();
  });

  // The rejection has to land before this run creates a resume archive, a report reservation,
  // or a work log, because the outer failure handler does not unwind an archive it never knew
  // about. Asserting the output directory stays empty is the observable form of that.
  it("rejects a base inside a grant before creating any controller output", async () => {
    const root = await createTempDir("pioneer-review-scratch-base-");
    const sourceDir = path.join(root, "source");
    const inside = path.join(sourceDir, "scratch");
    const outputDir = path.join(root, "outputs");
    await mkdir(sourceDir);
    await mkdir(inside);
    await mkdir(outputDir);

    await expect(
      runReview({
        sourceDir,
        prompt: "Review source",
        controllerScratchBase: inside,
        workLogPath: path.join(outputDir, "review.jsonl"),
        reportPath: path.join(outputDir, "report.md"),
        ...(process.platform === "win32" ? { allowUnsandboxedWindows: true } : {}),
      }),
    ).rejects.toThrow(/scratch base.*inside/i);

    expect(await readdir(outputDir)).toEqual([]);
  });

  it("announces the work log before report reservation can fail", async () => {
    const root = await createTempDir("pioneer-review-setup-");
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
