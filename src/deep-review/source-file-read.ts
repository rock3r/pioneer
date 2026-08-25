import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const MAX_SOURCE_FILE_READ_BYTES = 256 * 1024;
const MAX_SOURCE_FILE_SCAN_BYTES = 4 * 1024 * 1024;

export function readSourceFileLines(
  absolute: string,
  startLine: number,
  lineLimit: number,
): string[] {
  const fd = openSync(absolute, "r");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error("Source path is not a regular file");
    }

    let lineNumber = 0;
    let bytesScanned = 0;
    const lines: string[] = [];
    let carry = "";
    const chunkSize = 64 * 1024;
    let resultBytes = 0;

    while (bytesScanned < stats.size) {
      const toRead = Math.min(chunkSize, stats.size - bytesScanned);
      const buffer = Buffer.alloc(toRead);
      const read = readSync(fd, buffer, 0, toRead, bytesScanned);
      if (read <= 0) break;
      bytesScanned += read;
      carry += buffer.subarray(0, read).toString("utf8");

      while (carry.length > 0) {
        const newline = carry.indexOf("\n");
        const hasCompleteLine = newline !== -1;
        const line = hasCompleteLine ? carry.slice(0, newline) : carry;
        const isLastChunk = bytesScanned >= stats.size;
        if (!hasCompleteLine && !isLastChunk) break;

        carry = hasCompleteLine ? carry.slice(newline + 1) : "";
        lineNumber += 1;
        if (lineNumber >= startLine) {
          const lineBytes = Buffer.byteLength(line, "utf8") + (hasCompleteLine ? 1 : 0);
          if (lines.length > 0 && resultBytes + lineBytes > MAX_SOURCE_FILE_READ_BYTES) {
            return lines;
          }
          lines.push(line);
          resultBytes += lineBytes;
          if (lines.length >= lineLimit) {
            return lines;
          }
        }

        if (!hasCompleteLine && isLastChunk) break;
      }

      if (lineNumber < startLine && bytesScanned >= MAX_SOURCE_FILE_SCAN_BYTES) {
        throw new Error("Source read exceeded scan budget before requested offset");
      }
    }

    if (lineNumber < startLine) {
      return [];
    }
    return lines;
  } finally {
    closeSync(fd);
  }
}
