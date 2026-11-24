export const MAX_COMMENT_DIFF_BYTES = 8 * 1024 * 1024;

const MAX_DIFF_LINES = 200_000;
const MAX_PATH_BYTES = 4_096;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const FILE_METADATA =
  /^(?:index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename (?:from|to) |copy (?:from|to) |Binary files )/;
const ESCAPED_GIT_PATH_CHARACTER: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

export interface PatchLine {
  readonly kind: " " | "+" | "-";
  readonly text: string;
  readonly number: number;
}

export interface PatchHunk {
  readonly firstOldLine: number;
  readonly firstNewLine: number;
  readonly oldLines: number;
  readonly newLines: number;
  readonly lines: readonly PatchLine[];
}

interface PatchFile {
  readonly path: string | null;
  readonly hunks: readonly PatchHunk[];
}

function invalidDiff(): never {
  throw new Error(
    "[COMMENT_DIFF_INVALID] Expected a complete unified diff. Generate a plain patch with git diff --no-color.",
  );
}

function gitPath(value: string): string | null {
  if (value.length > MAX_PATH_BYTES * 4 + 128) invalidDiff();
  if (!value.startsWith('"')) {
    const raw = value.split("\t", 1)[0];
    if (!raw || Buffer.byteLength(raw) > MAX_PATH_BYTES || raw.includes("\0")) invalidDiff();
    return raw === "/dev/null" ? null : raw;
  }
  const encoded = /^"((?:[^"\\]|\\.)*)"(?:\t.*)?$/.exec(value)?.[1];
  if (encoded === undefined || encoded.length === 0) invalidDiff();
  const bytes: Buffer[] = [];
  for (const match of encoded.matchAll(/[^\\]+|\\(?:[0-3][0-7]{2}|.)/g)) {
    const token = match[0];
    if (!token.startsWith("\\")) bytes.push(Buffer.from(token));
    else if (token.length === 4) bytes.push(Buffer.from([Number.parseInt(token.slice(1), 8)]));
    else {
      const char = ESCAPED_GIT_PATH_CHARACTER[token.slice(1)];
      if (char === undefined) invalidDiff();
      bytes.push(Buffer.from(char));
    }
  }
  const decoded = Buffer.concat(bytes);
  if (decoded.length > MAX_PATH_BYTES || decoded.includes(0)) invalidDiff();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    invalidDiff();
  }
}

function* diffLines(diff: string): Generator<string> {
  let start = 0;
  let count = 0;
  while (start < diff.length) {
    count += 1;
    if (count > MAX_DIFF_LINES) {
      throw new Error("[COMMENT_DIFF_LIMIT] Unified diff exceeds 200,000 lines.");
    }
    const end = diff.indexOf("\n", start);
    const line = end < 0 ? diff.slice(start) : diff.slice(start, end);
    // Treat CRLF patches as equivalent to LF patches.
    yield line.endsWith("\r") ? line.slice(0, -1) : line;
    if (end < 0) break;
    start = end + 1;
  }
}

interface HunkState {
  readonly hunk: PatchHunk;
  readonly lines: PatchLine[];
  nextOld: number;
  nextNew: number;
  oldLeft: number;
  newLeft: number;
}

function openHunk(header: string): HunkState {
  const match = HUNK_HEADER.exec(header);
  if (match === null) invalidDiff();
  const firstOldLine = Number(match[1]);
  const oldLines = Number(match[2] ?? 1);
  const firstNewLine = Number(match[3]);
  const newLines = Number(match[4] ?? 1);
  if (
    ![firstOldLine + oldLines, firstNewLine + newLines].every(Number.isSafeInteger) ||
    (firstOldLine === 0 && oldLines !== 0) ||
    (firstNewLine === 0 && newLines !== 0) ||
    (oldLines === 0 && newLines === 0)
  )
    invalidDiff();

  const lines: PatchLine[] = [];
  return {
    hunk: { firstOldLine, firstNewLine, oldLines, newLines, lines },
    lines,
    nextOld: firstOldLine,
    nextNew: firstNewLine,
    oldLeft: oldLines,
    newLeft: newLines,
  };
}

function addHunkLine(hunk: HunkState, line: string): void {
  const kind = line[0];
  if (kind !== " " && kind !== "+" && kind !== "-") invalidDiff();
  hunk.lines.push({
    kind,
    text: line.slice(1),
    number: kind === "-" ? hunk.nextOld : hunk.nextNew,
  });
  if (kind !== "+") {
    hunk.nextOld += 1;
    hunk.oldLeft -= 1;
  }
  if (kind !== "-") {
    hunk.nextNew += 1;
    hunk.newLeft -= 1;
  }
  if (hunk.oldLeft < 0 || hunk.newLeft < 0) invalidDiff();
}

export function parseCommentDiff(diff: string): PatchFile[] {
  if (Buffer.byteLength(diff, "utf8") > MAX_COMMENT_DIFF_BYTES) {
    throw new Error("[COMMENT_DIFF_LIMIT] Unified diff exceeds 8 MiB.");
  }
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let hunks: PatchHunk[] = [];
  let oldPath: string | null | undefined;
  let gitHeader = false;
  let binary = false;
  let hunk: HunkState | undefined;
  for (const line of diffLines(diff)) {
    if (hunk !== undefined && line === "\\ No newline at end of file") continue;
    if (hunk !== undefined && (hunk.oldLeft !== 0 || hunk.newLeft !== 0)) {
      addHunkLine(hunk, line);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      if (oldPath !== undefined) invalidDiff();
      file = undefined;
      gitHeader = true;
      binary = false;
      hunk = undefined;
      continue;
    }
    if (binary) continue;
    if (line === "GIT binary patch" && gitHeader && file === undefined) {
      binary = true;
    } else if (line.startsWith("--- ")) {
      if (oldPath !== undefined) invalidDiff();
      file = undefined;
      oldPath = gitPath(line.slice(4));
      hunk = undefined;
    } else if (line.startsWith("+++ ")) {
      if (oldPath === undefined) invalidDiff();
      const target = gitPath(line.slice(4));
      const prefixed = (oldPath?.startsWith("a/") ?? gitHeader) && target?.startsWith("b/");
      hunks = [];
      file = { path: prefixed ? (target?.slice(2) ?? null) : target, hunks };
      files.push(file);
      oldPath = undefined;
    } else if (line.startsWith("@@ ")) {
      if (file === undefined) invalidDiff();
      hunk = openHunk(line);
      hunks.push(hunk.hunk);
    } else if (line !== "" && !(gitHeader && file === undefined && FILE_METADATA.test(line))) {
      invalidDiff();
    }
  }
  if (oldPath !== undefined || (hunk !== undefined && (hunk.oldLeft !== 0 || hunk.newLeft !== 0))) {
    invalidDiff();
  }
  return files;
}
