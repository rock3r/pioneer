import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeReviewReport } from "./report-output.js";
import { persistReviewReport } from "./runner.js";

describe("review report output", () => {
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
