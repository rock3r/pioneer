import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const EXTENSION_RUNTIME_FILES = [
  "dist/cli.js",
  "dist/core/package-manager.js",
  "dist/core/resource-loader.js",
  "dist/core/settings-manager.js",
] as const;

/** The official Pi package can host Pioneer's extension adapter. */
export async function piPackageHostsExtensionRuntime(packageRoot: string): Promise<boolean> {
  for (const relative of EXTENSION_RUNTIME_FILES) {
    const candidate = path.join(packageRoot, relative);
    try {
      await access(candidate, constants.R_OK);
      const canonical = await realpath(candidate);
      if (!(await lstat(canonical)).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** True when the executable is the package's declared `pi` entry point. */
export async function isDeclaredPiExecutable(
  executablePath: string,
  packageRoot: string,
): Promise<boolean> {
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(path.join(packageRoot, "package.json"), "utf8");
  } catch {
    return false;
  }
  if (Buffer.byteLength(manifestRaw) > 64 * 1024) return false;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw) as unknown;
  } catch {
    return false;
  }
  if (typeof manifest !== "object" || manifest === null) return false;
  const bin = (manifest as { bin?: unknown }).bin;
  const relative =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as { pi?: unknown }).pi
        : undefined;
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) {
    return false;
  }
  try {
    const declared = await realpath(path.join(packageRoot, relative));
    const executable = await realpath(executablePath);
    return declared === executable;
  } catch {
    return false;
  }
}
