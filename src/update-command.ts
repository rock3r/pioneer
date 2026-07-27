import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PIONEER_VERSION } from "./package-metadata.js";
import {
  checkForUpdate,
  PIONEER_PACKAGE_NAME,
  PIONEER_PACKAGE_REGISTRY,
  runTrustedNpm,
  type UpdateCheckResult,
} from "./update-check.js";

const RELEASE_API_URL = "https://api.github.com/repos/rock3r/pioneer/releases/tags/";
const MAX_CHANGELOG_BYTES = 1_024 * 1_024;

export interface UpdateCommandDependencies {
  readonly check: () => Promise<UpdateCheckResult>;
  readonly changelog: (version: string) => Promise<string>;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly install: (args: readonly string[]) => Promise<void>;
  readonly write: (message: string) => void;
}

function usage(): never {
  throw new Error("Usage: pioneer update [--changelog] [--yes|-y]");
}

async function confirmInteractive(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      `${question.trim()} requires an interactive terminal; pass the matching automation flag.`,
    );
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return /^(y|yes)$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Could not retrieve the changelog (HTTP ${response.status})`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_CHANGELOG_BYTES) {
    throw new Error("The changelog response is too large");
  }
  if (response.body === null) throw new Error("The changelog response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > MAX_CHANGELOG_BYTES) {
      await reader.cancel();
      throw new Error("The changelog response is too large");
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchChangelog(version: string): Promise<string> {
  const response = await fetch(`${RELEASE_API_URL}v${encodeURIComponent(version)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "pioneer-update-check" },
    signal: AbortSignal.timeout(10_000),
  });
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedBody(response)) as unknown;
  } catch (error) {
    throw error instanceof Error ? error : new Error("Could not parse the changelog response");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { body?: unknown }).body !== "string"
  ) {
    throw new Error("The changelog response did not contain release notes");
  }
  return (payload as { body: string }).body;
}

function installWithNpm(args: readonly string[]): Promise<void> {
  const prefix = installedNpmPrefix();
  return runTrustedNpm(prefix === undefined ? args : [...args, `--prefix=${prefix}`], "inherit");
}

export function installedNpmPrefix(
  modulePath = fileURLToPath(import.meta.url),
  platform = process.platform,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path;
  const distDirectory = pathApi.dirname(modulePath);
  const packageDirectory = pathApi.dirname(distDirectory);
  const scopeDirectory = pathApi.dirname(packageDirectory);
  const nodeModulesDirectory = pathApi.dirname(scopeDirectory);
  if (
    pathApi.basename(distDirectory) !== "dist" ||
    pathApi.basename(packageDirectory) !== "pioneer" ||
    pathApi.basename(scopeDirectory) !== "@rock3r" ||
    pathApi.basename(nodeModulesDirectory) !== "node_modules"
  ) {
    return undefined;
  }
  const packageRoot = pathApi.dirname(nodeModulesDirectory);
  const prefix = platform === "win32" ? packageRoot : pathApi.dirname(packageRoot);
  return pathApi.isAbsolute(prefix) ? prefix : undefined;
}

function defaultDependencies(): UpdateCommandDependencies {
  return {
    check: () => checkForUpdate({ currentVersion: PIONEER_VERSION, force: true }),
    changelog: fetchChangelog,
    confirm: confirmInteractive,
    install: installWithNpm,
    write: (message) => process.stdout.write(message),
  };
}

export async function runUpdateCommand(
  cliArgs: readonly string[],
  dependencies: UpdateCommandDependencies = defaultDependencies(),
): Promise<void> {
  const args = new Set(cliArgs);
  if (
    args.size !== cliArgs.length ||
    [...args].some((arg) => !["--changelog", "--yes", "-y"].includes(arg))
  ) {
    usage();
  }
  const automaticChangelog = args.has("--changelog");
  const automaticUpdate = args.has("--yes") || args.has("-y");
  const result = await dependencies.check();
  if (!result.updateAvailable || result.latestVersion === undefined) {
    dependencies.write(`Pioneer ${PIONEER_VERSION} is already up to date.\n`);
    return;
  }

  dependencies.write(`Update available: Pioneer ${PIONEER_VERSION} -> ${result.latestVersion}.\n`);
  if (automaticChangelog || (await dependencies.confirm("Show the changelog? [y/N] "))) {
    dependencies.write(`${(await dependencies.changelog(result.latestVersion)).trimEnd()}\n`);
  }
  if (!automaticUpdate && !(await dependencies.confirm("Update Pioneer now? [y/N] "))) {
    dependencies.write("Update not installed.\n");
    return;
  }
  dependencies.write(`Updating Pioneer with npm to ${result.latestVersion}...\n`);
  await dependencies.install([
    "install",
    "--global",
    `${PIONEER_PACKAGE_NAME}@${result.latestVersion}`,
    `--registry=${PIONEER_PACKAGE_REGISTRY}`,
    "--ignore-scripts",
  ]);
}
