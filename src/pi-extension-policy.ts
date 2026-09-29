import path from "node:path";
import { containsStandaloneCredential, isCredentialLabel } from "./diagnostics.js";

/**
 * A package or file name that is safe to echo. Raw load errors stay suppressed; only names
 * with a plain character set and no credential or long opaque segment are reported.
 */
function reportableName(value: string): string | undefined {
  if (!/^[A-Za-z0-9@._~/+-]{1,160}$/.test(value)) return undefined;
  if (/[A-Za-z0-9]{24,}/.test(value) || containsStandaloneCredential(value)) return undefined;
  if (value.split("/").some((segment) => isCredentialLabel(segment))) return undefined;
  return value;
}

/** The extension's last two path segments, for example `compose-pi/provider.ts`. */
function extensionLabel(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("path" in value)) return undefined;
  if (typeof value.path !== "string") return undefined;
  return reportableName(value.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/"));
}

/** The module Node could not resolve, relative to its innermost `node_modules`. */
function missingModule(text: string): string | undefined {
  const specifier = /Cannot find (?:module|package) '([^'\n]+)'/.exec(text)?.[1];
  if (specifier === undefined) return undefined;
  const normalized = specifier.replaceAll("\\", "/");
  const modules = normalized.lastIndexOf("/node_modules/");
  if (modules >= 0) return reportableName(normalized.slice(modules + "/node_modules/".length));
  // Any other absolute path is a local file whose name may reveal the operator's layout.
  if (path.isAbsolute(specifier) || /^[A-Za-z]:\//.test(normalized)) return undefined;
  return reportableName(normalized);
}

function isTrusted(extensionPath: string | undefined, trusted: readonly string[]): boolean {
  if (extensionPath === undefined) return false;
  // A trusted file matches exactly; a trusted package directory covers the entries Pi
  // resolved inside it. The separator stops a sibling such as `dir-evil` from matching.
  return trusted.some(
    (entry) =>
      extensionPath === entry ||
      extensionPath.startsWith(`${entry}/`) ||
      extensionPath.startsWith(`${entry}${path.sep}`),
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
      const missing = /Cannot find|MODULE_NOT_FOUND/.test(text);
      const module = missing ? missingModule(text) : undefined;
      const category = missing
        ? `missing dependency${module === undefined ? "" : ` ${module}`}`
        : /EPERM|EACCES|not permitted/.test(text)
          ? "sandbox access denied"
          : "initialization failed";
      const label = extensionLabel(value);
      return `entry ${index + 1}${label === undefined ? "" : ` (${label})`}: ${category}`;
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
