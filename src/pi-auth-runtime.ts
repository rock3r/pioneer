import { lstat, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type PiAuthBroker, startPiAuthBroker } from "./pi-auth-broker.js";
import { type PreparedReviewRuntime, runPreparedPiCommand } from "./pi-extension-discovery.js";
import { extensionPathsWithCapabilities } from "./pi-extension-snapshot.js";
import { prepareIsolatedPiHome } from "./pi-home.js";
import { createReviewScratchDirectory } from "./review/runner.js";

type OAuthCredential = Record<string, unknown> & {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

function parseAuth(content: string | undefined): Record<string, unknown> {
  if (content === undefined) return {};
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Auth configuration exceeds limit");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Invalid auth configuration");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid auth configuration");
  return value as Record<string, unknown>;
}

function oauth(value: unknown): value is OAuthCredential {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.type === "oauth" &&
    typeof entry.access === "string" &&
    typeof entry.refresh === "string" &&
    typeof entry.expires === "number" &&
    Number.isFinite(entry.expires)
  );
}

interface AuthBackend {
  withLockAsync<T>(
    operation: (current: string | undefined) => Promise<{ result: T; next?: string }>,
  ): Promise<T>;
}

export async function prepareAuthBroker(
  runtime: PreparedReviewRuntime,
): Promise<PiAuthBroker | undefined> {
  const root = runtime.extensions.runtimeRoot;
  if (root === undefined || process.platform === "win32") return undefined;
  const providers = await snapshotOAuthProviders(runtime.home.agentDir);
  if (providers.size === 0) return undefined;
  if (!(await lstat(path.join(runtime.home.sourceDir, "auth.json"))).isFile())
    throw new Error(
      "[PI_OAUTH_REFRESH_FAILED] Source auth.json must be a regular file, not a symlink, so Pioneer and Pi share the same credential lock.",
    );
  const authPath = await realpath(path.join(runtime.home.sourceDir, "auth.json"));
  const relative = path.relative(runtime.home.sourceDir, authPath);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new Error(
      "[PI_OAUTH_REFRESH_FAILED] Source credential file escapes the selected Pi home",
    );
  return await startRuntimeAuthBroker(runtime, root, authPath, providers);
}

export async function snapshotOAuthProviders(agentDir: string): Promise<ReadonlySet<string>> {
  const snapshotAuth = path.join(agentDir, "auth.json");
  const contents = await readFile(snapshotAuth, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return new Set(
    Object.entries(parseAuth(contents))
      .filter(([name, value]) => /^[a-zA-Z0-9._-]+$/.test(name) && oauth(value))
      .map(([name]) => name),
  );
}

async function startRuntimeAuthBroker(
  runtime: PreparedReviewRuntime,
  root: string,
  authPath: string,
  providers: ReadonlySet<string>,
): Promise<PiAuthBroker> {
  // Only the official installed Pi module runs in the controller. User extensions run
  // exclusively in the separate native worker below. Reuse Pi's lock with normal Pi.
  const { FileAuthStorageBackend } = (await import(
    pathToFileURL(path.join(root, "dist/core/auth-storage.js")).href
  )) as {
    FileAuthStorageBackend: new (file: string) => AuthBackend;
  };
  const backend = new FileAuthStorageBackend(authPath);
  return await startPiAuthBroker(providers, async (provider) => {
    let scratch: string | undefined;
    try {
      const refreshed = await backend.withLockAsync(async (current) => {
        const data = parseAuth(current);
        if (!Object.hasOwn(data, provider) || !oauth(data[provider]))
          throw new Error("OAuth credential unavailable");
        scratch = await createReviewScratchDirectory(path.dirname(runtime.scratch));
        const home = await prepareIsolatedPiHome({
          sourceDir: runtime.home.sourceDir,
          destination: path.join(scratch, "pi-home"),
          mode: "eval",
        });
        const workerAuth = path.join(home.agentDir, "auth.json");
        await writeFile(workerAuth, JSON.stringify({ [provider]: data[provider] }), {
          mode: 0o600,
        });
        // Open before launch and read back through this exact inode. A worker-created
        // symlink or replaced parent must never redirect a controller credential read.
        const workerResult = path.join(scratch, "auth-result.json");
        const authHandle = await open(workerResult, "wx+", 0o600);
        try {
          const workerRuntime: PreparedReviewRuntime = {
            scratch,
            extensionRoot: runtime.extensionRoot,
            home,
            extensions: runtime.extensions,
            network: runtime.network,
            ...(runtime.capabilityExtensions === undefined
              ? {}
              : { capabilityExtensions: runtime.capabilityExtensions }),
          };
          const result = await runPreparedPiCommand(
            workerRuntime,
            [
              process.execPath,
              path.join(runtime.extensionRoot, "extensions", "auth-worker.mjs"),
              root,
              provider,
              workerResult,
              ...extensionPathsWithCapabilities(
                runtime.extensions,
                runtime.capabilityExtensions ?? [],
              ),
            ],
            30_000,
          );
          if (result.exitCode !== 0)
            throw new Error("OAuth worker failed before returning its API result");
          const stats = await authHandle.stat();
          if (stats.nlink === 0 || stats.size > 1024 * 1024)
            throw new Error("Invalid OAuth worker output file");
          const bytes = Buffer.alloc(stats.size);
          const { bytesRead } = await authHandle.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== bytes.length) throw new Error("Incomplete OAuth worker result");
          const captured = parseAuth(bytes.toString("utf8"));
          const refreshed = captured.credential;
          if (!oauth(refreshed) || typeof captured.authenticated !== "boolean")
            throw new Error("Invalid OAuth worker result");
          // Preserve an already-written rotation even if a subsequent worker step failed.
          return {
            result: { credential: refreshed, succeeded: captured.authenticated },
            next: JSON.stringify({ ...data, [provider]: refreshed }, null, 2),
          };
        } finally {
          await authHandle.close();
        }
      });
      if (!refreshed.succeeded) throw new Error("OAuth worker failed");
      return refreshed.credential;
    } finally {
      // Cleanup follows the durable source write, so a cleanup failure cannot lose
      // a rotated token that has already invalidated its predecessor at the provider.
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  });
}
