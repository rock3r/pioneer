import { mkdir, mkdtemp, realpath } from "node:fs/promises";
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
