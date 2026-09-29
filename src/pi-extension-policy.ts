import path from "node:path";

function isTrusted(extensionPath: string | undefined, trusted: readonly string[]): boolean {
  if (extensionPath === undefined) return false;
  // A trusted file matches exactly; a trusted package directory covers the entries Pi
  // resolved inside it. The separator stops a sibling such as `dir-evil` from matching.
  return trusted.some(
    (entry) => extensionPath === entry || extensionPath.startsWith(`${entry}${path.sep}`),
  );
}

/** Provider registration has already happened; tool definitions remain a separate capability. */
export function restrictExtensionTools<
  T extends {
    extensions: { tools: Map<string, unknown>; path?: string }[];
    errors: readonly unknown[];
  },
>(result: T, trustedToolPaths: string | readonly string[] = []): T {
  const trusted = typeof trustedToolPaths === "string" ? [trustedToolPaths] : trustedToolPaths;
  if (result.errors.length !== 0) {
    const categories = result.errors.map((value, index) => {
      const text =
        typeof value === "object" && value !== null && "error" in value ? String(value.error) : "";
      const category = /Cannot find|MODULE_NOT_FOUND/.test(text)
        ? "missing dependency"
        : /EPERM|EACCES|not permitted/.test(text)
          ? "sandbox access denied"
          : "initialization failed";
      return `entry ${index + 1}: ${category}`;
    });
    throw new Error(
      `[PI_EXTENSION_LOAD_FAILED] Enabled extension failures: ${categories.join(", ")}. Check the installed extension set with normal Pi; unsupported filesystem, subprocess or network requirements must be adapted to the review sandbox. Raw extension diagnostics are suppressed to protect credentials.`,
    );
  }
  for (const extension of result.extensions) {
    if (!isTrusted(extension.path, trusted)) extension.tools.clear();
  }
  return result;
}
