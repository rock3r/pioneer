import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertControllerProviderAuthOutsideGrants,
  type ControllerProviderAuth,
  prepareControllerProviderAuth,
} from "./controller-provider-auth.js";
import {
  createEgressResolver,
  type EgressPolicy,
  type NetworkTier,
} from "./eval-run/egress-policy.js";
import { resolveLinuxBwrapPath } from "./eval-run/linux-install.js";
import { macosRuntimeReadPaths } from "./eval-run/macos-runtime.js";
import {
  type PreparedProviderNetwork,
  prepareProviderNetwork,
} from "./eval-run/provider-network.js";
import { startEgressProxy } from "./eval-run/public-egress-proxy.js";
import { captureEvalProcess } from "./eval-run/runner.js";
import type { PiAuthBroker } from "./pi-auth-broker.js";
import { prepareAuthBroker, snapshotOAuthProviders } from "./pi-auth-runtime.js";
import type { PiLaunchCommand } from "./pi-command.js";
import { assertExtensionCacheDisjointFromGrants } from "./pi-extension-cache-location.js";
import {
  extensionCacheSandboxPolicy,
  extensionSnapshotReadRoots,
  type PreparedExtensions,
  type PrepareExtensionCacheOptions,
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
  runReviewRpc,
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
  readonly extensionReadRoots: readonly string[];
  readonly home: PreparedPiHome;
  readonly extensions: PreparedExtensions;
  readonly network: NetworkTier;
  readonly egressPolicy?: EgressPolicy;
  readonly providerNetwork?: PreparedProviderNetwork;
  readonly authBroker?: PiAuthBroker;
  readonly controllerProviderAuth?: ControllerProviderAuth;
  readonly capabilityExtensions?: readonly string[];
}

export async function cleanupReviewRuntime(
  runtime: Pick<
    PreparedReviewRuntime,
    "scratch" | "extensionRoot" | "authBroker" | "controllerProviderAuth" | "extensions"
  >,
): Promise<void> {
  await runtime.authBroker?.close();
  const results = await Promise.allSettled([
    runtime.extensions.snapshotHandle?.release(),
    runtime.controllerProviderAuth?.gateway.close(),
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
  options: {
    readonly egress?: Pick<EgressPolicy, "allowHosts" | "blockHosts">;
    readonly repositorySource?: string;
    readonly cache?: PrepareExtensionCacheOptions;
  } = {},
  requestedModel?: string,
  protectProvider = false,
  homeMode: "review" | "classification" = "review",
): Promise<PreparedReviewRuntime> {
  signal?.throwIfAborted();
  const scratch = await createReviewScratchDirectory(scratchBase);
  let extensionRoot: string | undefined;
  let controllerProviderAuth: ControllerProviderAuth | undefined;
  let snapshotHandle: PreparedExtensions["snapshotHandle"];
  try {
    extensionRoot = await createReviewScratchDirectory(scratchBase);
    await assertExtensionCacheDisjointFromGrants({
      "runtime scratch": [scratch, extensionRoot],
      "capability extension": capabilityExtensions,
    });
    const policy = {
      network,
      ...(options.egress?.allowHosts ? { allowHosts: options.egress.allowHosts } : {}),
      ...(options.egress?.blockHosts ? { blockHosts: options.egress.blockHosts } : {}),
    };
    if (protectProvider) {
      controllerProviderAuth = await prepareControllerProviderAuth(
        agentDir,
        requestedModel,
        policy,
      );
    }
    const home = await prepareIsolatedPiHome({
      sourceDir: agentDir,
      destination: path.join(scratch, "pi-home"),
      mode: homeMode,
      environment,
      checkAborted: () => signal?.throwIfAborted(),
      ...(includes === undefined ? {} : { piHomeIncludes: includes }),
      ...(controllerProviderAuth === undefined
        ? {}
        : { controllerProviderFiles: controllerProviderAuth.files }),
    });
    const needsAuthAdapter =
      process.platform !== "win32" && (await snapshotOAuthProviders(home.agentDir)).size > 0;
    // Windows cannot run extension discovery, so copying the extension tree would only delay
    // the `PI_EXTENSION_DISCOVERY_UNSUPPORTED` that `runPreparedPiCommand` throws. Skip the
    // copy; callers still reach that error, with the same guidance, when they discover.
    const stageExtensions = process.platform !== "win32" && (extensionsEnabled || needsAuthAdapter);
    const extensions: PreparedExtensions = stageExtensions
      ? await preparePiExtensions(
          command,
          agentDir,
          path.join(extensionRoot, "extensions"),
          environment,
          signal,
          path.join(home.agentDir, "settings.json"),
          extensionsEnabled,
          undefined,
          options.repositorySource,
          options.cache ?? {},
        )
      : { command, paths: [], sourcePaths: [], digest: "0".repeat(64), entries: 0, bytes: 0 };
    snapshotHandle = extensions.snapshotHandle;
    const providerNetwork =
      controllerProviderAuth?.providerNetwork ??
      (await prepareProviderNetwork(policy, home.agentDir, requestedModel));
    const runtime = {
      scratch,
      extensionRoot,
      extensionReadRoots: extensionSnapshotReadRoots(extensionRoot, extensions),
      home,
      extensions,
      network,
      capabilityExtensions,
      providerNetwork,
      ...(controllerProviderAuth === undefined ? {} : { controllerProviderAuth }),
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
    await snapshotHandle?.release().catch(() => undefined);
    await controllerProviderAuth?.gateway.close().catch(() => undefined);
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
      ...withNoForkSandbox(runtime.extensions),
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
  return await withPreparedPiSandbox(
    runtime,
    command,
    signal,
    async (argv, environment) =>
      await captureEvalProcess(argv, runtime.home.homeDir, environment, timeoutMs, signal),
  );
}

export async function runPreparedPiRpc(
  runtime: PreparedReviewRuntime,
  command: PiLaunchCommand,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // This directory is empty and belongs to the runtime's read-only grant.
  const source = path.join(runtime.extensionRoot, "source");
  await mkdir(source, { mode: 0o700 });
  return await withPreparedPiSandbox(runtime, command, signal, async (argv, environment) => {
    signal?.throwIfAborted();
    // Once launched, runReviewRpc handles OS signals and waits for the actor to stop.
    return await runReviewRpc(argv, source, environment, prompt, timeoutMs, {
      maxRpcOutputBytes: 1024 * 1024,
      forbidTools: true,
      sensitiveValues: [prompt],
    });
  });
}

async function withPreparedPiSandbox<T>(
  runtime: PreparedReviewRuntime,
  command: PiLaunchCommand,
  signal: AbortSignal | undefined,
  execute: (argv: PiLaunchCommand, environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (process.platform === "win32")
    throw new Error(
      "[PI_EXTENSION_DISCOVERY_UNSUPPORTED] Extension discovery requires native sandbox support on macOS or Linux.",
    );
  const runtimePaths = [
    ...runtimeReadRoots(runtime.extensions),
    ...(await piRuntimePaths("pi")),
    ...(await piRuntimePaths("node")),
    ...(await macosRuntimeReadPaths(process.execPath)),
  ];
  const additionalExtensionGrants = (runtime.capabilityExtensions ?? []).filter(
    (entry) =>
      ![...runtime.extensionReadRoots, ...runtimePaths].some((root) => pathContains(root, entry)),
  );
  await assertExtensionCacheDisjointFromGrants({
    "runtime scratch": [runtime.scratch, runtime.extensionRoot],
    "Pi runtime": runtimePaths,
    "capability extension": additionalExtensionGrants,
  });
  await assertNativeSandboxReady();
  const resolve = createEgressResolver(
    runtime.providerNetwork?.policy ?? runtime.egressPolicy ?? { network: runtime.network },
  );
  const proxy = await startEgressProxy(
    crypto.randomUUID(),
    runtime.authBroker?.resolveWith(resolve) ?? resolve,
  );
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;
  try {
    const config: SandboxPolicy = {
      ...extensionCacheSandboxPolicy(runtime.extensions.snapshotHandle),
      readOnlyPaths: [...runtime.extensionReadRoots, ...additionalExtensionGrants, ...runtimePaths],
      writablePaths: [runtime.scratch],
      network: "proxy",
      proxyUrl: proxy.url,
      allowProcessFork: false,
    };
    if (runtime.controllerProviderAuth !== undefined) {
      await assertControllerProviderAuthOutsideGrants(runtime.home.sourceDir, [
        ...config.readOnlyPaths,
        ...config.writablePaths,
      ]);
    }
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
        await execute(
          launch.argv,
          reviewProcessEnvironment(launch.environment, {
            ...runtime.home.environment,
            HOME: runtime.home.homeDir,
            TMPDIR: runtime.home.tmpDir,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            NO_COLOR: "1",
          }),
        ),
    );
  } finally {
    await bridge?.close();
    if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
    await proxy.close();
  }
}
