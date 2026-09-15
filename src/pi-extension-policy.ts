/** Provider registration has already happened; tool definitions remain a separate capability. */
export function restrictExtensionTools<
  T extends {
    extensions: { tools: Map<string, unknown>; path?: string }[];
    errors: readonly unknown[];
  },
>(result: T, trustedInspectionPath?: string): T {
  if (result.errors.length !== 0) {
    const categories = result.errors.map((value, index) => {
      const text =
        typeof value === "object" && value !== null && "error" in value ? String(value.error) : "";
      const category = /Cannot find|MODULE_NOT_FOUND/.test(text)
        ? "missing dependency"
        : /EPERM|EACCES|not permitted/.test(text)
          ? "sandbox access denied"
          : "initialization failed";
      const filename =
        typeof value === "object" && value !== null && "path" in value
          ? String(value.path).split(/[\\/]/).slice(-2).join("/")
          : "unknown";
      const safeName =
        /^[a-z0-9_.\-/]{1,100}$/i.test(filename) && !/token|secret|key|password/i.test(filename)
          ? filename
          : `entry ${index + 1}`;
      return `${safeName}: ${category}`;
    });
    throw new Error(
      `[PI_EXTENSION_LOAD_FAILED] Enabled extension failures: ${categories.join(", ")}. Check the installed extension set with normal Pi; unsupported filesystem, subprocess or network requirements must be adapted to the review sandbox. Raw extension diagnostics are suppressed to protect credentials.`,
    );
  }
  for (const extension of result.extensions) {
    if (trustedInspectionPath === undefined || extension.path !== trustedInspectionPath)
      extension.tools.clear();
  }
  return result;
}
