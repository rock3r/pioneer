import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const EXTENSION_RUNTIME_FILES = [
  "dist/cli.js",
  "dist/core/package-manager.js",
  "dist/core/resource-loader.js",
  "dist/core/settings-manager.js",
] as const;
const AUTH_RUNTIME_FILES = [
  "dist/core/auth-storage.js",
  "dist/core/http-dispatcher.js",
  "dist/core/resource-loader.js",
] as const;

async function readableRegularFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.R_OK);
    const canonical = await realpath(candidate);
    return (await lstat(canonical)).isFile();
  } catch {
    return false;
  }
}

/** The official Pi package can host Pioneer's extension adapter. */
export async function piPackageHostsExtensionRuntime(packageRoot: string): Promise<boolean> {
  for (const relative of EXTENSION_RUNTIME_FILES) {
    if (!(await readableRegularFile(path.join(packageRoot, relative)))) return false;
  }
  return true;
}

/** The package can host the OAuth broker and auth worker without a missing import. */
export async function piPackageHostsAuthAdapter(packageRoot: string): Promise<boolean> {
  for (const relative of AUTH_RUNTIME_FILES) {
    if (!(await readableRegularFile(path.join(packageRoot, relative)))) return false;
  }
  const runtime = await readableRegularFile(path.join(packageRoot, "dist/core/model-runtime.js"));
  const registry = await readableRegularFile(path.join(packageRoot, "dist/core/model-registry.js"));
  return runtime || registry;
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
