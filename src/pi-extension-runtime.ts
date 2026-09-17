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
import { piRuntimeStorage, piStorageEnvironment } from "./pi-runtime-storage.js";

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

export async function preparePiExtensions(
  command: PiLaunchCommand,
  sourceAgentDir: string,
  destination: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  settingsFile = path.join(sourceAgentDir, "settings.json"),
  enabled = true,
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
  const snapshot = await snapshotExtensionResources(
    resources,
    destination,
    signal,
    enabled
      ? await piRuntimeStorage(sourceAgentDir, settingsFile, piStorageEnvironment(environment))
      : undefined,
  );
  const entry = path.join(destination, "entry.mjs");
  const policy = path.join(destination, "pi-extension-policy.js");
  await copyFile(fileURLToPath(new URL("./pi-extension-entry.js", import.meta.url)), entry);
  await copyFile(fileURLToPath(new URL("./pi-extension-policy.js", import.meta.url)), policy);
  await copyFile(
    fileURLToPath(new URL("./pi-auth-client.js", import.meta.url)),
    path.join(destination, "pi-auth-client.js"),
  );
  await copyFile(
    fileURLToPath(new URL("./pi-provider-id.js", import.meta.url)),
    path.join(destination, "pi-provider-id.js"),
  );
  await copyFile(
    fileURLToPath(new URL("./pi-auth-worker.js", import.meta.url)),
    path.join(destination, "auth-worker.mjs"),
  );
  await writeFile(path.join(destination, "package.json"), '{"type":"module"}', { mode: 0o600 });
  return {
    ...snapshot,
    ...(enabled ? {} : { digest: "0".repeat(64) }),
    command: [process.execPath, entry, root],
    runtimeRoot: root,
  };
}
