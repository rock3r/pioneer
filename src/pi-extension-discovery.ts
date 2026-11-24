import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  createEgressResolver,
  type EgressPolicy,
  type NetworkTier,
} from "./eval-run/egress-policy.js";
import { resolveLinuxBwrapPath } from "./eval-run/linux-install.js";
import { macosRuntimeReadPaths } from "./eval-run/macos-runtime.js";
import { resolveProviderPolicy } from "./eval-run/provider-network.js";
import { startEgressProxy } from "./eval-run/public-egress-proxy.js";
import { captureEvalProcess } from "./eval-run/runner.js";
import type { PiAuthBroker } from "./pi-auth-broker.js";
import { prepareAuthBroker, snapshotOAuthProviders } from "./pi-auth-runtime.js";
import type { PiLaunchCommand } from "./pi-command.js";
import {
  type PreparedExtensions,
  preparePiExtensions,
  runtimeReadRoots,
  withNoForkSandbox,
} from "./pi-extension-runtime.js";
import { extensionPathsWithCapabilities } from "./pi-extension-snapshot.js";
import { type PreparedPiHome, prepareIsolatedPiHome } from "./pi-home.js";
import type { PiProbeResult } from "./pi-readiness.js";
import { withPiStagedIntegrity } from "./pi-staged-integrity.js";
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

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export interface PreparedReviewRuntime {
  readonly scratch: string;
  readonly extensionRoot: string;
  readonly home: PreparedPiHome;
  readonly extensions: PreparedExtensions;
  readonly network: NetworkTier;
  readonly egressPolicy?: EgressPolicy;
  readonly authBroker?: PiAuthBroker;
  readonly capabilityExtensions?: readonly string[];
}

export async function cleanupReviewRuntime(
  runtime: Pick<PreparedReviewRuntime, "scratch" | "extensionRoot" | "authBroker">,
): Promise<void> {
  await runtime.authBroker?.close();
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
  network: NetworkTier = "full",
  signal?: AbortSignal,
  capabilityExtensions: readonly string[] = [],
  filters?: Pick<EgressPolicy, "allowHosts" | "blockHosts">,
  requestedModel?: string,
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
      environment,
      checkAborted: () => signal?.throwIfAborted(),
      ...(includes === undefined ? {} : { piHomeIncludes: includes }),
    });
    const needsAuthAdapter =
      process.platform !== "win32" && (await snapshotOAuthProviders(home.agentDir)).size > 0;
    // Windows cannot run extension discovery, so copying the extension tree would only delay
    // the `PI_EXTENSION_DISCOVERY_UNSUPPORTED` that `runPreparedPiCommand` throws. Skip the
    // copy; callers still reach that error, with the same guidance, when they discover.
    const stageExtensions = process.platform !== "win32" && (extensionsEnabled || needsAuthAdapter);
    const extensions = stageExtensions
      ? await preparePiExtensions(
          command,
          agentDir,
          path.join(extensionRoot, "extensions"),
          environment,
          signal,
          path.join(home.agentDir, "settings.json"),
          extensionsEnabled,
        )
      : { command, paths: [], sourcePaths: [], digest: "0".repeat(64), entries: 0, bytes: 0 };
    const egressPolicy = await resolveProviderPolicy(
      {
        network,
        ...(filters?.allowHosts ? { allowHosts: filters.allowHosts } : {}),
        ...(filters?.blockHosts ? { blockHosts: filters.blockHosts } : {}),
      },
      home.agentDir,
      requestedModel,
    );
    const runtime = {
      scratch,
      extensionRoot,
      home,
      extensions,
      network,
      capabilityExtensions,
      egressPolicy,
    };
    const authBroker = await prepareAuthBroker(runtime);
    return authBroker === undefined
      ? runtime
      : {
          ...runtime,
          authBroker,
          home: { ...home, environment: { ...home.environment, ...authBroker.environment } },
        };
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
  return await runPreparedPiCommand(
    runtime,
    [
      ...withNoForkSandbox(runtime.extensions.command),
      "--offline",
      "--no-approve",
      "--no-extensions",
      ...extensionPathsWithCapabilities(
        runtime.extensions,
        runtime.capabilityExtensions ?? [],
      ).flatMap((entry) => ["--extension", entry]),
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--list-models",
    ],
    timeoutMs,
    signal,
  );
}

export async function runPreparedPiCommand(
  runtime: PreparedReviewRuntime,
  command: PiLaunchCommand,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PiProbeResult> {
  signal?.throwIfAborted();
  if (process.platform === "win32")
    throw new Error(
      "[PI_EXTENSION_DISCOVERY_UNSUPPORTED] Extension discovery requires native sandbox support on macOS or Linux.",
    );
  await assertNativeSandboxReady();
  const resolve = createEgressResolver(runtime.egressPolicy ?? { network: runtime.network });
  const proxy = await startEgressProxy(
    crypto.randomUUID(),
    runtime.authBroker?.resolveWith(resolve) ?? resolve,
  );
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;
  try {
    const config: SandboxPolicy = {
      readOnlyPaths: [
        runtime.extensionRoot,
        ...(runtime.capabilityExtensions ?? []).filter(
          (entry) =>
            !pathContains(runtime.extensionRoot, entry) &&
            !runtimeReadRoots(runtime.extensions).some((root) => pathContains(root, entry)),
        ),
        ...runtimeReadRoots(runtime.extensions),
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
    return await withPiStagedIntegrity(
      {
        agentDir: runtime.home.agentDir,
        extensionRoot: runtime.extensionRoot,
        checkAborted: () => signal?.throwIfAborted(),
      },
      async () =>
        await captureEvalProcess(
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
        ),
    );
  } finally {
    await bridge?.close();
    if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
    await proxy.close();
  }
}
