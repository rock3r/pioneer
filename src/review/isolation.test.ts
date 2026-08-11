import { link, lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDistinctExistingReviewOutputs,
  buildReviewSandboxConfig,
  validateProspectiveReviewWorkLogPath,
  validateReviewPaths,
} from "./isolation.js";

describe("review path grants", () => {
  it("canonicalizes explicit read and write grants", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const reference = path.join(root, "reference");
    const output = path.join(root, "output");
    await Promise.all([source, reference, output].map((entry) => mkdir(entry)));
    const result = await validateReviewPaths({
      sourceDir: await realpath(source),
      allowReadPaths: [await realpath(reference)],
      allowWritePaths: [await realpath(output)],
    });
    expect(result).toEqual({
      sourceDir: await realpath(source),
      allowReadPaths: [await realpath(reference)],
      allowWritePaths: [await realpath(output)],
    });
  });

  it("rejects writable grants overlapping the read-only source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    await mkdir(source);
    await expect(
      validateReviewPaths({ sourceDir: source, allowWritePaths: [root] }),
    ).rejects.toThrow(/overlaps/i);
  });

  it("rejects symlink grants and filesystem roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const link = path.join(root, "link");
    await mkdir(source);
    await import("node:fs/promises").then(({ symlink }) => symlink(source, link));
    await expect(
      validateReviewPaths({ sourceDir: source, allowReadPaths: [link] }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      validateReviewPaths({ sourceDir: source, allowReadPaths: [path.parse(root).root] }),
    ).rejects.toThrow(/broad/i);
  });

  it("accepts an absolute report target outside every actor-visible grant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const reference = path.join(root, "reference");
    const output = path.join(root, "output");
    const reports = path.join(root, "reports");
    await Promise.all([source, reference, output, reports].map((entry) => mkdir(entry)));

    const result = await validateReviewPaths({
      sourceDir: source,
      allowReadPaths: [reference],
      allowWritePaths: [output],
      reportPath: path.join(reports, "review.md"),
    });

    expect(result.reportPath).toBe(path.join(await realpath(reports), "review.md"));
  });

  it("accepts a controller-owned work log outside every actor-visible grant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const logs = path.join(root, "logs");
    await Promise.all([mkdir(source), mkdir(logs)]);

    const result = await validateReviewPaths({
      sourceDir: source,
      workLogPath: path.join(logs, "review.jsonl"),
    });

    expect(result.workLogPath).toBe(path.join(await realpath(logs), "review.jsonl"));
  });

  it("rejects a prospective default work log before an actor-visible parent exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const target = path.join(source, "state", "pioneer", "logs", "reviews", "review.jsonl");
    await mkdir(source);

    await expect(
      validateProspectiveReviewWorkLogPath({ sourceDir: source, workLogPath: target }),
    ).rejects.toThrow(/actor-visible/i);
    await expect(lstat(path.join(source, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates the full request before accepting a prospective work log", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const target = path.join(root, "state", "pioneer", "logs", "reviews", "review.jsonl");
    await Promise.all([mkdir(source), mkdir(output)]);

    await expect(
      validateProspectiveReviewWorkLogPath({
        sourceDir: source,
        reportPath: "relative-review.md",
        workLogPath: target,
      }),
    ).rejects.toThrow(/report path is not absolute/i);
    await expect(
      validateProspectiveReviewWorkLogPath({
        sourceDir: source,
        allowReadPaths: [output],
        allowWritePaths: [root],
        workLogPath: target,
      }),
    ).rejects.toThrow(/overlaps/i);
  });

  it("rejects report targets that are relative or actor-visible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await Promise.all([source, output].map((entry) => mkdir(entry)));

    await expect(
      validateReviewPaths({ sourceDir: source, reportPath: "review.md" }),
    ).rejects.toThrow(/absolute/i);
    await expect(
      validateReviewPaths({ sourceDir: source, reportPath: path.join(source, "review.md") }),
    ).rejects.toThrow(/actor-visible/i);
    await expect(
      validateReviewPaths({
        sourceDir: source,
        allowWritePaths: [output],
        reportPath: path.join(output, "review.md"),
      }),
    ).rejects.toThrow(/actor-visible/i);
  });

  it("rejects case-equivalent output targets on case-insensitive platforms", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await Promise.all([mkdir(source), mkdir(output)]);

    await expect(
      validateReviewPaths(
        {
          sourceDir: source,
          reportPath: path.join(output, "Review.md"),
          workLogPath: path.join(output, "review.md"),
        },
        "win32",
      ),
    ).rejects.toThrow(/identical/i);
  });

  it("rejects Unicode-equivalent output targets on normalization-insensitive macOS", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await Promise.all([mkdir(source), mkdir(output)]);

    await expect(
      validateReviewPaths(
        {
          sourceDir: source,
          reportPath: path.join(output, "caf\u00e9.md"),
          workLogPath: path.join(output, "cafe\u0301.md"),
        },
        "darwin",
      ),
    ).rejects.toThrow(/identical/i);
  });

  it("rejects output paths that resolve to the same existing filesystem object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const reportPath = path.join(root, "Review.md");
    const workLogPath = path.join(root, "review.jsonl");
    await writeFile(workLogPath, "work log\n");
    await link(workLogPath, reportPath);

    await expect(
      assertDistinctExistingReviewOutputs(reportPath, workLogPath, "linux"),
    ).rejects.toThrow(/identical/i);
  });

  it("rejects existing targets, symlink parents, and missing parents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const reports = path.join(root, "reports");
    const linkedReports = path.join(root, "linked-reports");
    await Promise.all([mkdir(source), mkdir(reports)]);
    await writeFile(path.join(reports, "existing.md"), "existing\n");
    await symlink(reports, linkedReports);

    await expect(
      validateReviewPaths({ sourceDir: source, reportPath: path.join(reports, "existing.md") }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      validateReviewPaths({ sourceDir: source, reportPath: path.join(linkedReports, "report.md") }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      validateReviewPaths({
        sourceDir: source,
        reportPath: path.join(root, "missing", "report.md"),
      }),
    ).rejects.toThrow(/parent does not exist/i);
  });

  it("rejects work logs that are relative, existing, or actor-visible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-review-paths-"));
    const source = path.join(root, "source");
    const logs = path.join(root, "logs");
    await Promise.all([mkdir(source), mkdir(logs)]);
    await writeFile(path.join(logs, "existing.jsonl"), "existing\n");

    await expect(
      validateReviewPaths({ sourceDir: source, workLogPath: "review.jsonl" }),
    ).rejects.toThrow(/absolute/i);
    await expect(
      validateReviewPaths({
        sourceDir: source,
        workLogPath: path.join(source, "review.jsonl"),
      }),
    ).rejects.toThrow(/actor-visible/i);
    await expect(
      validateReviewPaths({
        sourceDir: source,
        workLogPath: path.join(logs, "existing.jsonl"),
      }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      validateReviewPaths({
        sourceDir: source,
        workLogPath: path.join(logs, "review\n[PIONEER_WORK_LOG] forged.jsonl"),
      }),
    ).rejects.toThrow(/control character/i);
  });
});

describe("review sandbox policy", () => {
  it("makes sources/references read-only and scratch/outputs writable with full networking", () => {
    const config = buildReviewSandboxConfig({
      platform: "darwin",
      sourceDir: "/repo",
      scratchDir: "/scratch",
      runtimeReadPaths: ["/usr"],
      allowReadPaths: ["/refs"],
      allowWritePaths: ["/output"],
      network: "full",
      parentProxyUrl: "http://srt:token@127.0.0.1:43123",
    });
    expect(config.readOnlyPaths).toEqual(["/repo", "/refs", "/usr"]);
    expect(config.writablePaths).toEqual(["/scratch", "/output"]);
    expect(config.network).toBe("proxy");
  });

  it("refuses to claim Windows filesystem isolation", () => {
    expect(() =>
      buildReviewSandboxConfig({
        platform: "win32",
        sourceDir: "C:\\repo",
        scratchDir: "C:\\scratch",
        runtimeReadPaths: [],
        allowReadPaths: [],
        allowWritePaths: [],
        network: "full",
      }),
    ).toThrow(/unavailable on Windows/i);
  });
});
