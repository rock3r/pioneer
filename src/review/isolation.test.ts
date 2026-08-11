import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewSandboxConfig, validateReviewPaths } from "./isolation.js";

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
