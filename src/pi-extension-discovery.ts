import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { resolveLinuxBwrapPath } from "./eval-run/linux-install.js";
import { macosRuntimeReadPaths } from "./eval-run/macos-runtime.js";
import {
  resolveAnyTarget,
  resolvePublicTarget,
  startEgressProxy,
} from "./eval-run/public-egress-proxy.js";
import { captureEvalProcess } from "./eval-run/runner.js";
import type { PiLaunchCommand } from "./pi-command.js";
import { type PreparedExtensions, preparePiExtensions } from "./pi-extension-runtime.js";
import { type PreparedPiHome, prepareIsolatedPiHome } from "./pi-home.js";
import type { PiProbeResult } from "./pi-readiness.js";
import {
  createReviewScratchDirectory,
  piRuntimePaths,
  reviewProcessEnvironment,
} from "./review/runner.js";
import {
  buildLinuxSandboxArgv,
  buildMacosSandboxArgv,
  type SandboxPolicy,
} from "./sandbox/launcher.js";
import { type LinuxProxyBridge, startLinuxProxyBridge } from "./sandbox/linux-proxy-bridge.js";
import { assertNativeSandboxReady } from "./sandbox/platform-readiness.js";

export interface PreparedReviewRuntime {
  readonly scratch: string;
  readonly extensionRoot: string;
  readonly home: PreparedPiHome;
  readonly extensions: PreparedExtensions;
  readonly network: "full" | "public";
}

export async function cleanupReviewRuntime(
  runtime: Pick<PreparedReviewRuntime, "scratch" | "extensionRoot">,
): Promise<void> {
  const results = await Promise.allSettled([
    rm(runtime.scratch, { recursive: true, force: true }),
    rm(runtime.extensionRoot, { recursive: true, force: true }),
  ]);
  if (results.some((result) => result.status === "rejected"))
    throw new Error(
      "[PI_EXTENSION_CLEANUP_FAILED] A private configuration or extension snapshot could not be removed.",
    );
}

export async function prepareReviewRuntime(
  command: PiLaunchCommand,
  agentDir: string,
  environment: NodeJS.ProcessEnv,
  scratchBase = "/tmp",
  includes?: readonly string[],
  extensionsEnabled = true,
  network: "full" | "public" = "full",
  signal?: AbortSignal,
): Promise<PreparedReviewRuntime> {
  signal?.throwIfAborted();
  const scratch = await createReviewScratchDirectory(scratchBase);
  let extensionRoot: string | undefined;
  try {
    extensionRoot = await createReviewScratchDirectory(scratchBase);
    const home = await prepareIsolatedPiHome({
      sourceDir: agentDir,
      destination: path.join(scratch, "pi-home"),
      mode: "review",
      checkAborted: () => signal?.throwIfAborted(),
      ...(includes === undefined ? {} : { piHomeIncludes: includes }),
    });
    const extensions = extensionsEnabled
      ? await preparePiExtensions(
          command,
          agentDir,
          path.join(extensionRoot, "extensions"),
          environment,
          signal,
          path.join(home.agentDir, "settings.json"),
        )
      : { command, paths: [], digest: "0".repeat(64) };
    return { scratch, extensionRoot, home, extensions, network };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    if (extensionRoot !== undefined) await rm(extensionRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function discoverPreparedExtensions(
  runtime: PreparedReviewRuntime,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<PiProbeResult> {
  signal?.throwIfAborted();
  if (process.platform === "win32")
    throw new Error(
      "[PI_EXTENSION_DISCOVERY_UNSUPPORTED] Extension discovery requires native sandbox support on macOS or Linux.",
    );
  await assertNativeSandboxReady();
  const proxy = await startEgressProxy(
    crypto.randomUUID(),
    runtime.network === "public" ? resolvePublicTarget : resolveAnyTarget,
  );
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;
  try {
    const command: PiLaunchCommand = [
      ...runtime.extensions.command,
      "--offline",
      "--no-approve",
      "--no-extensions",
      ...runtime.extensions.paths.flatMap((entry) => ["--extension", entry]),
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--list-models",
    ];
    const config: SandboxPolicy = {
      readOnlyPaths: [
        runtime.extensionRoot,
        ...(runtime.extensions.runtimeRoot === undefined ? [] : [runtime.extensions.runtimeRoot]),
        ...(await piRuntimePaths("pi")),
        ...(await piRuntimePaths("node")),
        ...(await macosRuntimeReadPaths(process.execPath)),
      ],
      writablePaths: [runtime.scratch],
      network: "proxy",
      proxyUrl: proxy.url,
      allowProcessFork: false,
    };
    let launch: ReturnType<typeof buildLinuxSandboxArgv>;
    if (process.platform === "darwin") launch = buildMacosSandboxArgv(config, command);
    else {
      const bwrap = await resolveLinuxBwrapPath();
      if (bwrap === undefined)
        throw new Error("[PI_EXTENSION_DISCOVERY_UNSUPPORTED] Bubblewrap is required.");
      bridgeRoot = await mkdtemp(path.join(path.dirname(runtime.scratch), "pir-bridge-"));
      bridge = await startLinuxProxyBridge(proxy.url, path.join(bridgeRoot, "proxy.sock"));
      launch = buildLinuxSandboxArgv(config, command, bwrap, bridge.socketPath);
    }
    return await captureEvalProcess(
      launch.argv,
      runtime.home.homeDir,
      reviewProcessEnvironment(launch.environment, {
        ...runtime.home.environment,
        HOME: runtime.home.homeDir,
        TMPDIR: runtime.home.tmpDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
      }),
      timeoutMs,
      signal,
    );
  } finally {
    await bridge?.close();
    if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
    await proxy.close();
  }
}
