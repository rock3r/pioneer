import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bundledDeepReviewInspectionExtensionPath,
  bundledDeepReviewInspectionRuntimeReadPaths,
} from "./inspection-extension.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

describe("bundledDeepReviewInspectionRuntimeReadPaths", () => {
  it("includes the extension entry and its source-access runtime dependency", () => {
    const packageRoot = path.join(moduleDirectory, "..", "..");
    const paths = bundledDeepReviewInspectionRuntimeReadPaths(packageRoot);
    expect(paths).toEqual([
      bundledDeepReviewInspectionExtensionPath(packageRoot),
      path.join(packageRoot, "dist", "deep-review", "source-access.js"),
    ]);
  });
});
