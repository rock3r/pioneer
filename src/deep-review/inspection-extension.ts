import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled deep-review inspection extension entry file. */
export function bundledDeepReviewInspectionExtensionPath(
  packageRoot: string = path.join(moduleDirectory, "..", ".."),
): string {
  return path.join(packageRoot, "dist", "deep-review", "inspection-extension", "index.ts");
}

/** Runtime files the bundled inspection extension may import inside the actor sandbox. */
export function bundledDeepReviewInspectionRuntimeReadPaths(
  packageRoot: string = path.join(moduleDirectory, "..", ".."),
): readonly string[] {
  const deepReviewDist = path.join(packageRoot, "dist", "deep-review");
  return [
    bundledDeepReviewInspectionExtensionPath(packageRoot),
    path.join(deepReviewDist, "bounded-response.js"),
    path.join(deepReviewDist, "source-access.js"),
    path.join(deepReviewDist, "source-file-read.js"),
  ];
}

export const DEEP_REVIEW_INSPECTION_TOOL_NAMES = [
  "get_pr_metadata",
  "list_changed_files",
  "read_patch",
  "read_rule",
  "read_previous_finding",
  "read_source_file",
  "list_source_directory",
  "list_candidates",
  "read_candidate",
] as const;

export function deepReviewActorTools(includePresidentTools: boolean): readonly string[] {
  const base = [
    "get_pr_metadata",
    "list_changed_files",
    "read_patch",
    "read_rule",
    "read_previous_finding",
    "read_source_file",
    "list_source_directory",
  ];
  if (!includePresidentTools) return base;
  return [...base, "list_candidates", "read_candidate"];
}
