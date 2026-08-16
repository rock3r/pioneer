import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const removeTemporary = vi.hoisted(() =>
  vi.fn(async (...args: Parameters<typeof import("node:fs/promises").rm>) => {
    const { rm } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return rm(...args);
  }),
);

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: removeTemporary,
}));

import {
  publishReservedReviewReport,
  releaseReviewReportReservation,
  reserveReviewReport,
  writeReviewReport,
} from "./report-output.js";
import { persistReviewReport } from "./runner.js";

describe("review report output", () => {
  it("reserves the private report target before publishing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");

    const reservation = await reserveReviewReport(target);

    expect(await readFile(target, "utf8")).toContain("PIONEER_REPORT_RESERVED");
    await publishReservedReviewReport({ ...reservation, device: 0, inode: 0 }, "No findings.");
    expect(await readFile(target, "utf8")).toBe("No findings.\n");
  });

  it("does not publish over or remove a replaced report reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    await import("node:fs/promises").then(({ rm }) => rm(target));
    await writeFile(target, "replacement\n");

    await expect(publishReservedReviewReport(reservation, "No findings.")).rejects.toThrow(
      /reservation/i,
    );
    await releaseReviewReportReservation(reservation);

    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("removes an unpublished report reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);

    await releaseReviewReportReservation(reservation);

    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a reservation that was modified in place", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    await writeFile(target, "replacement\n");

    await releaseReviewReportReservation(reservation);

    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("atomically creates a private report file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const reports = path.join(root, "reports");
    const target = path.join(reports, "report.md");
    await mkdir(reports);

    await writeReviewReport(target, "No findings.");

    expect(await readFile(target, "utf8")).toBe("No findings.\n");
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it("never overwrites an existing report target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    await writeFile(target, "existing\n");

    await expect(writeReviewReport(target, "replacement")).rejects.toThrow(/already exists/i);

    expect(await readFile(target, "utf8")).toBe("existing\n");
  });

  it("does not turn a published report into a failure when temp cleanup fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    removeTemporary.mockRejectedValueOnce(new Error("temporary cleanup failed"));

    await expect(writeReviewReport(target, "No findings.")).resolves.toBeUndefined();

    expect(await readFile(target, "utf8")).toBe("No findings.\n");
  });

  it("preserves a valid report when optional persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    await writeFile(target, "existing\n");

    await expect(persistReviewReport("Valid report", target)).resolves.toBe(
      `[REVIEW_REPORT_WRITE_FAILED] Pioneer received a review report but could not persist it at ${target}: Review report target already exists: ${target}`,
    );
    expect(await readFile(target, "utf8")).toBe("existing\n");
  });
});
