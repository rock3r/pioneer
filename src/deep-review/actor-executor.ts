import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { validateControllerScratchBase } from "../controller-scratch.js";
import { resolveLinuxBwrapPath } from "../eval-run/linux-install.js";
import { macosRuntimeReadPaths } from "../eval-run/macos-runtime.js";
import { resolvePublicTarget, startEgressProxy } from "../eval-run/public-egress-proxy.js";
import { defaultPiAgentDir, prepareIsolatedPiHome } from "../pi-home.js";
import { assertPiReady } from "../pi-readiness.js";
import { optimizePiStartupCommand } from "../pi-startup.js";
import { buildReviewSandboxConfig, validateReviewPaths } from "../review/isolation.js";
import {
  createReviewScratchDirectory,
  piRuntimePaths,
  reviewProcessEnvironment,
  runReviewRpc,
} from "../review/runner.js";
import { buildLinuxSandboxArgv, buildMacosSandboxArgv } from "../sandbox/launcher.js";
import { type LinuxProxyBridge, startLinuxProxyBridge } from "../sandbox/linux-proxy-bridge.js";
import { assertNativeSandboxReady } from "../sandbox/platform-readiness.js";
import { resolveSelectedCapabilityExtensions } from "./capability-profile.js";
import type { CouncilMemberV1, DeepReviewConfigV1 } from "./config.js";
import type { PresidentOutputV1, WorkerOutputV1 } from "./finding.js";
import { parsePresidentOutputV1, parseWorkerOutputV1 } from "./finding.js";
import {
  bundledDeepReviewInspectionExtensionPath,
  bundledDeepReviewInspectionRuntimeReadPaths,
  deepReviewActorTools,
} from "./inspection-extension.js";
import { maximumModelOutputBytes } from "./result-output.js";
import type {
  DeepReviewActorExecutor,
  DeepReviewPresidentActorRequest,
  DeepReviewWorkerActorRequest,
} from "./runner.js";
import {
  buildStructuredActorPiCommand,
  deepReviewActorEnvironment,
  parseStructuredActorOutput,
} from "./structured-actor.js";

export interface CreateDeepReviewActorExecutorOptions {
  readonly piHomeSource?: string;
  readonly packageRoot?: string;
  readonly config: DeepReviewConfigV1;
}

async function stageActorStoreFile(
  sourcePath: string,
  actorScratchDir: string,
  fileName: string,
): Promise<string> {
  const destination = path.join(actorScratchDir, fileName);
  await copyFile(sourcePath, destination);
  return destination;
}

async function launchStructuredActor(
  request: {
    readonly member: CouncilMemberV1;
    readonly prompt: string;
    readonly packetPath: string;
    readonly sourceDir: string;
    readonly actorScratchDir: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly includePresidentTools: boolean;
    readonly candidateStorePath?: string;
    readonly signal?: AbortSignal;
  },
  options: CreateDeepReviewActorExecutorOptions,
): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("[DEEP_REVIEW_WORKER_FAILED] deep review is unsupported on Windows");
  }

  const validatedPaths = await validateReviewPaths({ sourceDir: request.sourceDir });
  const piHomeSource = await (await import("node:fs/promises")).realpath(
    options.piHomeSource ?? defaultPiAgentDir(),
  );
  const forbiddenPaths = [validatedPaths.sourceDir, piHomeSource];
  const capabilityExtensions = await resolveSelectedCapabilityExtensions(
    options.config,
    forbiddenPaths,
  );
  const inspectionExtension = bundledDeepReviewInspectionExtensionPath(options.packageRoot);
  const extensionPaths = [
    ...capabilityExtensions,
    ...bundledDeepReviewInspectionRuntimeReadPaths(options.packageRoot),
  ];

  await assertPiReady({
    environment: { ...process.env, PI_CODING_AGENT_DIR: piHomeSource },
    requestedModel: request.member.model,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  await assertNativeSandboxReady();

  const runtimeReadPaths = [
    ...(await piRuntimePaths("pi")),
    ...(await piRuntimePaths("node")),
    ...(await macosRuntimeReadPaths(process.execPath)),
    ...extensionPaths,
  ];

  const scratchDir = request.actorScratchDir;
  const actorPacketPath = await stageActorStoreFile(request.packetPath, scratchDir, "packet.json");
  const actorCandidateStorePath =
    request.candidateStorePath === undefined
      ? undefined
      : await stageActorStoreFile(request.candidateStorePath, scratchDir, "candidates.json");
  const piHome = await prepareIsolatedPiHome({
    sourceDir: piHomeSource,
    destination: path.join(scratchDir, "pi-home"),
    mode: "eval",
  });
  const sessionDir = await mkdtemp(path.join(scratchDir, "session-"));

  const baseCommand = buildStructuredActorPiCommand("pi", {
    model: request.member.model,
    ...(request.member.thinking === undefined ? {} : { thinking: request.member.thinking }),
    tools: deepReviewActorTools(request.includePresidentTools),
    extensionPath: inspectionExtension,
    piHomeDir: piHome.agentDir,
    sessionDir,
    actorEnvironment: {},
  });

  const optimized = optimizePiStartupCommand(baseCommand, {
    disableExtensions: true,
    disableSkills: true,
    extensions: capabilityExtensions,
    noSession: false,
    sessionDir,
    tools: deepReviewActorTools(request.includePresidentTools),
  });

  const actorEnvironment = deepReviewActorEnvironment(
    { ...optimized.environment, ...piHome.environment },
    {
      piHomeDir: piHome.agentDir,
      homeDir: piHome.homeDir,
      tmpDir: piHome.tmpDir,
      packetPath: actorPacketPath,
      sourceDir: validatedPaths.sourceDir,
      ...(actorCandidateStorePath === undefined
        ? {}
        : { candidateStorePath: actorCandidateStorePath }),
    },
  );

  const environment = {
    ...actorEnvironment,
    ...(process.platform === "darwin"
      ? {
          OPENSSL_CONF: "/private/etc/ssl/openssl.cnf",
          SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
        }
      : {}),
  };

  let proxy: Awaited<ReturnType<typeof startEgressProxy>> | undefined;
  let bridge: LinuxProxyBridge | undefined;
  let bridgeRoot: string | undefined;

  try {
    proxy = await startEgressProxy(crypto.randomUUID(), resolvePublicTarget);
    const bwrapPath = process.platform === "linux" ? await resolveLinuxBwrapPath() : undefined;
    if (process.platform === "linux" && bwrapPath === undefined) {
      throw new Error("Linux sandboxing requires Bubblewrap (`bwrap`) to be installed");
    }
    if (process.platform === "linux" && proxy !== undefined) {
      const scratchBase = "/tmp";
      bridgeRoot = await mkdtemp(path.join(scratchBase, "pdr-bridge-"));
      bridge = await startLinuxProxyBridge(proxy.url, path.join(bridgeRoot, "proxy.sock"));
    }

    const sandboxConfig = buildReviewSandboxConfig({
      platform: process.platform as "darwin" | "linux",
      ...validatedPaths,
      scratchDir,
      runtimeReadPaths,
      network: "public",
      parentProxyUrl: proxy.url,
      sessionDir,
    });
    const launch =
      process.platform === "darwin"
        ? buildMacosSandboxArgv({ ...sandboxConfig, allowProcessFork: false }, optimized.command)
        : buildLinuxSandboxArgv(
            sandboxConfig,
            optimized.command,
            bwrapPath ?? "",
            bridge?.socketPath,
          );

    return await runReviewRpc(
      launch.argv,
      validatedPaths.sourceDir,
      reviewProcessEnvironment(launch.environment, environment),
      request.prompt,
      request.timeoutMs,
    );
  } finally {
    await bridge?.close();
    if (bridgeRoot !== undefined) {
      await rm(bridgeRoot, { recursive: true, force: true });
    }
    await proxy?.close();
  }
}

export function createDeepReviewActorExecutor(
  options: CreateDeepReviewActorExecutorOptions,
): DeepReviewActorExecutor {
  return {
    async runWorker(request: DeepReviewWorkerActorRequest): Promise<WorkerOutputV1> {
      const assistantText = await launchStructuredActor(
        {
          member: request.member,
          prompt: request.prompt,
          packetPath: request.packetPath,
          sourceDir: request.sourceDir,
          actorScratchDir: request.actorScratchDir,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          includePresidentTools: false,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        options,
      );
      return parseStructuredActorOutput(assistantText, {
        maxOutputBytes: request.maxOutputBytes,
        parse: parseWorkerOutputV1,
      });
    },
    async runPresident(request: DeepReviewPresidentActorRequest): Promise<PresidentOutputV1> {
      const assistantText = await launchStructuredActor(
        {
          member: request.member,
          prompt: request.prompt,
          packetPath: request.packetPath,
          sourceDir: request.sourceDir,
          actorScratchDir: request.actorScratchDir,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          includePresidentTools: true,
          candidateStorePath: request.candidateStorePath,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        options,
      );
      return parseStructuredActorOutput(assistantText, {
        maxOutputBytes: request.maxOutputBytes,
        parse: parsePresidentOutputV1,
      });
    },
  };
}

export function defaultDeepReviewMaxOutputBytes(
  config: CreateDeepReviewActorExecutorOptions["config"],
): number {
  return maximumModelOutputBytes(config);
}

export async function createDeepReviewActorScratch(scratchBase: string): Promise<string> {
  const base = await validateControllerScratchBase(scratchBase);
  return createReviewScratchDirectory(base);
}
