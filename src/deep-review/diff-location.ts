import type { DiffSideV1 } from "./finding.js";
import type { PullRequestFileV1 } from "./packet.js";

export interface DiffHunkLine {
  readonly side: DiffSideV1;
  readonly line: number;
}

export interface ChangedHunkRange {
  readonly side: DiffSideV1;
  readonly startLine: number;
  readonly endLine: number;
}

function parseUnifiedDiffHunks(patch: string): ChangedHunkRange[] {
  const ranges: ChangedHunkRange[] = [];
  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      ranges.push({ side: "LEFT", startLine: oldLine, endLine: oldLine });
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      ranges.push({ side: "RIGHT", startLine: newLine, endLine: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      oldLine += 1;
      newLine += 1;
    }
  }

  return mergeAdjacentRanges(ranges);
}

function mergeAdjacentRanges(ranges: ChangedHunkRange[]): ChangedHunkRange[] {
  if (ranges.length === 0) return [];
  const merged: ChangedHunkRange[] = [];
  const first = ranges[0];
  if (!first) return [];
  let current = { ...first };
  for (let index = 1; index < ranges.length; index += 1) {
    const next = ranges[index];
    if (!next) continue;
    if (next.side === current.side && next.startLine === current.endLine + 1) {
      current = { ...current, endLine: next.endLine };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

export function changedHunksForFile(file: PullRequestFileV1): ChangedHunkRange[] {
  if (file.contentKind === "binary" || !file.patch) {
    return [];
  }
  return parseUnifiedDiffHunks(file.patch);
}

export function lineRangeOverlapsHunk(
  side: DiffSideV1,
  line: number,
  endLine: number,
  hunks: readonly ChangedHunkRange[],
): boolean {
  return hunks.some(
    (hunk) => hunk.side === side && line <= hunk.endLine && endLine >= hunk.startLine,
  );
}

export function validateFindingLocation(
  file: PullRequestFileV1,
  side: DiffSideV1,
  line: number,
  endLine: number,
): boolean {
  if (file.contentKind === "binary") return false;
  if (endLine < line) return false;
  const hunks = changedHunksForFile(file);
  return lineRangeOverlapsHunk(side, line, endLine, hunks);
}

export function findingRangeWithinSingleHunk(
  side: DiffSideV1,
  line: number,
  endLine: number,
  hunks: readonly ChangedHunkRange[],
): boolean {
  const matchingHunks = hunks.filter(
    (hunk) => hunk.side === side && line <= hunk.endLine && endLine >= hunk.startLine,
  );
  if (matchingHunks.length !== 1) return false;
  const hunk = matchingHunks[0];
  if (!hunk) return false;
  return line >= hunk.startLine && endLine <= hunk.endLine;
}

export function isGitHubPublishableLocation(
  file: PullRequestFileV1,
  side: DiffSideV1,
  line: number,
  endLine: number,
): boolean {
  if (!validateFindingLocation(file, side, line, endLine)) return false;
  if (side === "LEFT" && line !== endLine) return false;
  if (line === endLine) return true;
  return findingRangeWithinSingleHunk(side, line, endLine, changedHunksForFile(file));
}

export interface GitHubInlineCommentMapping {
  readonly path: string;
  readonly side: DiffSideV1;
  readonly line: number;
  readonly startLine?: number;
  readonly startSide?: DiffSideV1;
}

export function mapToGitHubInlineComment(
  filePath: string,
  side: DiffSideV1,
  line: number,
  endLine: number,
): GitHubInlineCommentMapping {
  if (line === endLine) {
    return { path: filePath, side, line };
  }
  return {
    path: filePath,
    side,
    line: endLine,
    startLine: line,
    startSide: side,
  };
}

export function findPacketFile(
  files: readonly PullRequestFileV1[],
  path: string,
): PullRequestFileV1 | undefined {
  return files.find((file) => file.path === path);
}
