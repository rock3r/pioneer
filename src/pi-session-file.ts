import { open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** A first parseable line longer than this is treated as history rather than read further. */
export const PI_SESSION_SCAN_LINE_LIMIT = 1024 * 1024;

/**
 * Whether a file is Pi session history, judged by content.
 *
 * Pi's `sessionDir` can come from a project's `.pi/settings.json`, `--session-dir`, or other
 * sources Pioneer cannot see, so a known-location exclusion cannot cover every session. Pi
 * stores sessions only as `.jsonl` files and takes the first parseable line as the header,
 * skipping blank and malformed lines. This mirrors that, accepts any case of the extension,
 * and requires only `type: "session"`, which is broader than Pi's own header check. Pass every
 * name the file is reached by, such as a link and its canonical target, in `names`.
 */
export async function isPiSessionFile(
  filePath: string,
  names: readonly string[] = [filePath],
): Promise<boolean> {
  if (!names.some((name) => path.basename(name).toLowerCase().endsWith(".jsonl"))) return false;
  if (!(await stat(filePath)).isFile()) return false;
  const handle = await open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      pending += bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline >= 0 || (bytesRead === 0 && pending.length > 0)) {
        const line = newline >= 0 ? pending.slice(0, newline) : pending;
        pending = newline >= 0 ? pending.slice(newline + 1) : "";
        if (line.length > PI_SESSION_SCAN_LINE_LIMIT) return true;
        const header = parseLine(line);
        if (header)
          return (
            typeof header === "object" && (header as Record<string, unknown>).type === "session"
          );
        newline = pending.indexOf("\n");
      }
      if (pending.length > PI_SESSION_SCAN_LINE_LIMIT) return true;
      if (bytesRead === 0) return false;
    }
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
