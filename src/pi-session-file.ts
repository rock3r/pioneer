import { open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Bytes read while looking for the header. A file still undecided after this is history. */
export const PI_SESSION_SCAN_BYTE_LIMIT = 1024 * 1024;

/**
 * Totals of the header scans in one snapshot. The per-file limit does not bound the total, so
 * every scan charges the files it opens and the bytes it reads here, and fails closed past a limit.
 */
export interface PiSessionScanBudget {
  readonly maxFiles: number;
  readonly maxBytes: number;
  files: number;
  bytes: number;
  /** Builds the snapshot's own error from a description of the exceeded limit and the totals. */
  readonly limitError: (detail: string) => Error;
}

/** Defaults to the snapshot backstops for selected content: 500,000 files and 1 GiB. */
export function createPiSessionScanBudget(
  limitError: (detail: string) => Error,
  limits: { readonly files: number; readonly bytes: number } = {
    files: 500_000,
    bytes: 1024 ** 3,
  },
): PiSessionScanBudget {
  return { maxFiles: limits.files, maxBytes: limits.bytes, files: 0, bytes: 0, limitError };
}

function charge(budget: PiSessionScanBudget, files: number, bytes: number): void {
  budget.files += files;
  budget.bytes += bytes;
  const fileCount = `${budget.files} ${budget.files === 1 ? "file" : "files"}`;
  const read = `${(budget.bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (budget.files > budget.maxFiles)
    throw budget.limitError(
      `session-history scans exceed the ${budget.maxFiles}-file limit (${fileCount}, ${read} read).`,
    );
  if (budget.bytes > budget.maxBytes) {
    const limit =
      budget.maxBytes % 1024 ** 3 === 0
        ? `${budget.maxBytes / 1024 ** 3} GiB`
        : `${(budget.maxBytes / 1024 ** 2).toFixed(1)} MiB`;
    throw budget.limitError(
      `session-history scans exceed the ${limit} read limit (${read} read from ${fileCount}).`,
    );
  }
}

/**
 * Whether a file is Pi session history, judged by content.
 *
 * Pi's `sessionDir` can come from a project's `.pi/settings.json`, `--session-dir`, or other
 * sources Pioneer cannot see, so a known-location exclusion cannot cover every session. Pi
 * stores sessions only as `.jsonl` files and takes the first parseable line as the header,
 * skipping blank and malformed lines. This mirrors that, accepts any case of the extension,
 * and requires only `type: "session"`, which is broader than Pi's own header check. Pass every
 * name the file is reached by, such as a link and its canonical target, in `names`. A file with
 * more than one hard link is checked whatever its names, because another name can be `.jsonl`.
 * When `filePath` is a copy, pass the source's link count as `linkCount`. Each opened file and
 * every byte read is charged to `budget`, which throws once a cumulative limit is passed.
 */
export async function isPiSessionFile(
  filePath: string,
  budget: PiSessionScanBudget,
  names: readonly string[] = [filePath],
  linkCount?: number,
): Promise<boolean> {
  const named = names.some((name) => path.basename(name).toLowerCase().endsWith(".jsonl"));
  const details = await stat(filePath);
  if (!details.isFile() || (!named && (linkCount ?? details.nlink) <= 1)) return false;
  charge(budget, 1, 0);
  const handle = await open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = "";
    let scanned = 0;
    while (scanned <= PI_SESSION_SCAN_BYTE_LIMIT) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      scanned += bytesRead;
      charge(budget, 0, bytesRead);
      pending += bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline >= 0 || (bytesRead === 0 && pending.length > 0)) {
        const line = newline >= 0 ? pending.slice(0, newline) : pending;
        pending = newline >= 0 ? pending.slice(newline + 1) : "";
        const header = parseLine(line);
        if (header)
          return (
            typeof header === "object" && (header as Record<string, unknown>).type === "session"
          );
        newline = pending.indexOf("\n");
      }
      if (bytesRead === 0) return false;
    }
    return true;
  } finally {
    await handle.close();
  }
}

/** Pi skips blank, malformed, and falsy lines, such as `null`, when it looks for the header. */
function parseLine(line: string): unknown {
  if (line.trim().length === 0) return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
