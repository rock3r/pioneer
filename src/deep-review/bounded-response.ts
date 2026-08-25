export function boundedText(text: string, maxBytes: number): string {
  const suffix = "…[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const contentLimit = Math.max(0, maxBytes - suffixBytes);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > contentLimit) {
    end -= 1;
  }
  return `${text.slice(0, end)}${suffix}`;
}
