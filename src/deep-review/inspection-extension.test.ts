import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundedText } from "./bounded-response.js";
import {
  bundledDeepReviewInspectionExtensionPath,
  bundledDeepReviewInspectionRuntimeReadPaths,
} from "./inspection-extension.js";
import { readSourceFileLines } from "./source-file-read.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

describe("bundledDeepReviewInspectionRuntimeReadPaths", () => {
  it("includes the extension entry and its source-access runtime dependency", () => {
    const packageRoot = path.join(moduleDirectory, "..", "..");
    const paths = bundledDeepReviewInspectionRuntimeReadPaths(packageRoot);
    expect(paths).toEqual([
      bundledDeepReviewInspectionExtensionPath(packageRoot),
      path.join(packageRoot, "dist", "deep-review", "bounded-response.js"),
      path.join(packageRoot, "dist", "deep-review", "source-access.js"),
      path.join(packageRoot, "dist", "deep-review", "source-file-read.js"),
    ]);
  });
});

describe("boundedText", () => {
  it("truncates by UTF-8 bytes and reserves suffix space", () => {
    const text = "é".repeat(100);
    const truncated = boundedText(text, 50);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(50);
    expect(truncated.endsWith("…[truncated]")).toBe(true);
  });
});

describe("readSourceFileLines", () => {
  it("returns lines beyond the initial 256 KiB when offset requests them", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pioneer-inspection-"));
    try {
      const filePath = path.join(tempDir, "large.txt");
      const prefix = `${"x".repeat(79)}\n`.repeat(3_500);
      const targetLine = "TARGET-LINE";
      writeFileSync(filePath, `${prefix}${targetLine}\ntail\n`, "utf8");

      expect(readSourceFileLines(filePath, 3_501, 1)).toEqual([targetLine]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
