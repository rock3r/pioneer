import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PiLaunchCommand } from "./pi-command.js";
import {
  type ExtensionResource,
  type ExtensionSnapshot,
  snapshotExtensionResources,
} from "./pi-extension-snapshot.js";
import { piRuntimeStorage } from "./pi-runtime-storage.js";

const execute = promisify(execFile);
const RESOLVE = `
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,agentDir,cwd,settingsFile] = process.argv.slice(1);
const {SettingsManager}=await import(pathToFileURL(path.join(root,'dist/core/settings-manager.js')));
const {DefaultPackageManager}=await import(pathToFileURL(path.join(root,'dist/core/package-manager.js')));
let settings={};
try { settings=JSON.parse(fs.readFileSync(settingsFile,'utf8')); }
catch(error) { if(error.code!=='ENOENT') throw new Error('Invalid Pi settings'); }
const manager=new DefaultPackageManager({cwd,agentDir,settingsManager:SettingsManager.inMemory(settings,{projectTrusted:false})});
const result=await manager.resolve();
process.stdout.write(JSON.stringify(result.extensions));
`;

export async function installedPiRoot(
  command: PiLaunchCommand,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = [...command].reverse();
  if (!path.isAbsolute(command[0]))
    candidates.push(
      ...(environment.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(entry, command[0])),
    );
  for (const argument of candidates) {
    if (!path.isAbsolute(argument)) continue;
    let directory: string;
    try {
      if (!path.isAbsolute(command[0])) await access(argument, constants.X_OK);
      directory = path.dirname(await realpath(argument));
    } catch {
      continue;
    }
    for (let count = 0; count < 8; count++) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        ) as { name?: unknown };
        if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
      } catch {
        /* Continue through launcher ancestry, without executing package content. */
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!path.isAbsolute(command[0])) break;
  }
  throw new Error(
    "[PI_EXTENSION_RUNTIME_UNSUPPORTED] Extension support requires the official installed Pi Node package.",
  );
}

function parseResources(value: unknown): ExtensionResource[] {
  if (!Array.isArray(value)) throw new Error("Invalid resources");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("Invalid resource");
    const resource = item as Record<string, unknown>;
    const metadata = resource.metadata as Record<string, unknown> | undefined;
    if (
      typeof resource.path !== "string" ||
      !path.isAbsolute(resource.path) ||
      typeof resource.enabled !== "boolean" ||
      !metadata ||
      typeof metadata.scope !== "string"
    )
      throw new Error("Invalid resource");
    return {
      path: resource.path,
      enabled: resource.enabled,
      metadata: {
        scope: metadata.scope,
        ...(typeof metadata.origin === "string" ? { origin: metadata.origin } : {}),
        ...(typeof metadata.baseDir === "string" ? { baseDir: metadata.baseDir } : {}),
      },
    };
  });
}

export interface PreparedExtensions extends ExtensionSnapshot {
  readonly command: PiLaunchCommand;
  readonly runtimeRoot?: string;
}

/**
 * Compiled modules staged beside the extension snapshot, as `[source, staged name]`. The
 * adapter runs from this private copy inside the sandbox, so every relative import of a
 * staged module must also be staged. The policy reuses the credential detectors in
 * `diagnostics.js` to decide which load-failure names to report.
 */
export const EXTENSION_ADAPTER_FILES: readonly (readonly [string, string])[] = [
  ["pi-extension-entry.js", "entry.mjs"],
  ["pi-extension-policy.js", "pi-extension-policy.js"],
  ["pi-extension-subprocess-guard.js", "pi-extension-subprocess-guard.js"],
  ["diagnostics.js", "diagnostics.js"],
  ["pi-auth-client.js", "pi-auth-client.js"],
  ["pi-provider-id.js", "pi-provider-id.js"],
  ["pi-auth-worker.js", "auth-worker.mjs"],
];

/**
 * macOS review, discovery and deep-review actors run without process creation. The flag tells
 * the adapter that a spawn `EPERM` is that sandbox denial, so it keeps Pi running. Other
 * actors may create processes, so there the error keeps Node's default handling.
 */
export function withNoForkSandbox(
  command: readonly [string, ...string[]],
  platform: NodeJS.Platform = process.platform,
): readonly [string, ...string[]] {
  return platform === "darwin" ? [...command, "--pioneer-no-fork-sandbox"] : command;
}

export async function preparePiExtensions(
  command: PiLaunchCommand,
  sourceAgentDir: string,
  destination: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  settingsFile = path.join(sourceAgentDir, "settings.json"),
  enabled = true,
  excludedPaths: readonly string[] = [],
): Promise<PreparedExtensions> {
  signal?.throwIfAborted();
  const root = await installedPiRoot(command, environment);
  let resources: ExtensionResource[] = [];
  try {
    if (enabled) {
      const result = await execute(
        process.execPath,
        ["--input-type=module", "--eval", RESOLVE, root, sourceAgentDir, destination, settingsFile],
        {
          env: { ...environment, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
          timeout: 30_000,
          ...(signal === undefined ? {} : { signal }),
          maxBuffer: 1024 * 1024,
        },
      );
      resources = parseResources(JSON.parse(result.stdout));
    }
  } catch {
    throw new Error(
      "[PI_EXTENSION_RESOLUTION_FAILED] Pi could not resolve its installed user extensions. Verify the selected Pi settings and installed packages with normal Pi. Extension code was not executed.",
    );
  }
  let snapshot: Awaited<ReturnType<typeof snapshotExtensionResources>>;
  try {
    snapshot = await snapshotExtensionResources(
      resources,
      destination,
      signal,
      enabled ? await piRuntimeStorage(sourceAgentDir, settingsFile, environment) : undefined,
      undefined,
      excludedPaths,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("[PI_") || error.message.startsWith("Explicit Pi extension"))
    ) {
      throw error;
    }
    throw new Error("Pi extension could not be staged");
  }
  for (const [source, target] of EXTENSION_ADAPTER_FILES) {
    await copyFile(
      fileURLToPath(new URL(`./${source}`, import.meta.url)),
      path.join(destination, target),
    );
  }
  const entry = path.join(destination, "entry.mjs");
  await writeFile(path.join(destination, "package.json"), '{"type":"module"}', { mode: 0o600 });
  return {
    ...snapshot,
    ...(enabled ? {} : { digest: "0".repeat(64) }),
    command: [process.execPath, entry, root],
    runtimeRoot: root,
  };
}
