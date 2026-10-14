import { open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Bytes read while looking for the header. A file still undecided after this is history. */
export const PI_SESSION_SCAN_BYTE_LIMIT = 1024 * 1024;

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
 */
export async function isPiSessionFile(
  filePath: string,
  names: readonly string[] = [filePath],
): Promise<boolean> {
  const named = names.some((name) => path.basename(name).toLowerCase().endsWith(".jsonl"));
  const details = await stat(filePath);
  if (!details.isFile() || (!named && details.nlink <= 1)) return false;
  const handle = await open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = "";
    let scanned = 0;
    while (scanned <= PI_SESSION_SCAN_BYTE_LIMIT) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      scanned += bytesRead;
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
