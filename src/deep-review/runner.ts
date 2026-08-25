import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertScratchBaseOutsideGrants,
  validateControllerScratchBase,
} from "../controller-scratch.js";
import { macosRuntimeReadPaths } from "../eval-run/macos-runtime.js";
import { defaultPiAgentDir } from "../pi-home.js";
import {
  validateProspectiveDeepReviewOutputPaths,
  validateReviewPaths,
} from "../review/isolation.js";
import {
  type ReviewReportReservation,
  releaseReviewReportReservation,
  reserveReviewReport,
} from "../review/report-output.js";
import {
  canonicalReviewPiHomeSource,
  createReviewScratchDirectory,
  piRuntimePaths,
} from "../review/runner.js";
import { createDeepReviewActorExecutor } from "./actor-executor.js";
import {
  classifyPresidentOutput,
  failedPresidentOutcome,
  successfulPresidentOutcome,
} from "./classifier.js";
import type { CouncilMemberV1, DeepReviewConfigV1 } from "./config.js";
import { computeMinimumSupport, resolvedConfigLimits } from "./config.js";
import {
  type CandidateRecord,
  countSuccessfulIndependenceGroups,
  quorumAvailable,
  type SafeDiagnosticV1,
} from "./consensus.js";
import { runWithBoundedConcurrency, settledWorkerOutcome } from "./council.js";
import type { PresidentOutputV1, WorkerOutputV1 } from "./finding.js";
import { computeCandidateId } from "./ids.js";
import {
  DEFAULT_MAXIMUM_PACKET_BYTES,
  type PullRequestPacketV1,
  validatePacketCompleteness,
} from "./packet.js";
import { buildPresidentPrompt, buildWorkerPrompt } from "./prompt.js";
import type { PresidentOutcomeV1, WorkerOutcomeV1 } from "./result.js";
import { type DeepReviewResultV1, persistDeepReviewResult } from "./result-output.js";
import { diagnosticRecord, newRunId, openDeepReviewWorkLog } from "./work-log.js";

export interface DeepReviewRequest {
  readonly sourceDir: string;
  readonly packet: PullRequestPacketV1;
  readonly config: DeepReviewConfigV1;
  readonly resultPath?: string;
  readonly workLogPath?: string;
  readonly controllerScratchBase?: string;
  readonly signal?: AbortSignal;
  readonly actorExecutor?: DeepReviewActorExecutor;
}

export interface DeepReviewWorkerActorRequest {
  readonly member: CouncilMemberV1;
  readonly prompt: string;
  readonly packetPath: string;
  readonly sourceDir: string;
  readonly actorScratchDir: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface DeepReviewPresidentActorRequest {
  readonly member: CouncilMemberV1;
  readonly prompt: string;
  readonly packetPath: string;
  readonly candidateStorePath: string;
  readonly sourceDir: string;
  readonly actorScratchDir: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface DeepReviewActorExecutor {
  runWorker(request: DeepReviewWorkerActorRequest): Promise<WorkerOutputV1>;
  runPresident(request: DeepReviewPresidentActorRequest): Promise<PresidentOutputV1>;
}

const WINDOWS_UNSUPPORTED =
  "[DEEP_REVIEW_WORKER_FAILED] Pioneer deep review is unsupported on Windows";

export function assertDeepReviewPlatform(config: DeepReviewConfigV1): void {
  if (process.platform === "win32") {
    throw new Error(WINDOWS_UNSUPPORTED);
  }
  if (config.focusedCommands !== undefined) {
    throw new Error(
      "[DEEP_REVIEW_CONFIG_INVALID] focusedCommands execution is disabled until Slice 10 ships",
    );
  }
}

export async function validateDeepReviewSource(sourceDir: string): Promise<string> {
  const validated = await validateReviewPaths({ sourceDir });
  return validated.sourceDir;
}

export interface DeepReviewExecution {
  readonly result: DeepReviewResultV1;
  readonly resultPath: string;
  readonly workLogPath: string;
}

export async function runDeepReview(request: DeepReviewRequest): Promise<DeepReviewExecution> {
  assertDeepReviewPlatform(request.config);

  const limits = resolvedConfigLimits(request.config);
  validatePacketCompleteness(
    request.packet,
    request.config.limits?.maximumPacketBytes ?? DEFAULT_MAXIMUM_PACKET_BYTES,
  );
  const sourceDir = await validateDeepReviewSource(request.sourceDir);
  const runId = newRunId();
  const validatedOutputs = await validateProspectiveDeepReviewOutputPaths({
    sourceDir,
    ...(request.resultPath === undefined ? {} : { resultPath: request.resultPath }),
    ...(request.workLogPath === undefined ? {} : { workLogPath: request.workLogPath }),
  });
  const resultPath =
    validatedOutputs.resultPath ?? path.join(os.tmpdir(), `pioneer-deep-review-${runId}.json`);
  const workLogPath =
    validatedOutputs.workLogPath ?? path.join(os.tmpdir(), `pioneer-deep-review-${runId}.jsonl`);
  const workLog = await openDeepReviewWorkLog(workLogPath);

  let resultReservation: ReviewReportReservation | undefined;
  if (request.resultPath !== undefined) {
    resultReservation = await reserveReviewReport(resultPath);
  }

  const scratchBase =
    request.controllerScratchBase === undefined
      ? process.platform === "win32"
        ? os.tmpdir()
        : "/tmp"
      : await validateControllerScratchBase(request.controllerScratchBase);

  if (request.controllerScratchBase !== undefined) {
    const runtimeReadPaths =
      process.platform === "win32"
        ? []
        : [
            ...(await piRuntimePaths("pi")),
            ...(await piRuntimePaths("node")),
            ...(await macosRuntimeReadPaths(process.execPath)),
          ];
    assertScratchBaseOutsideGrants(scratchBase, [sourceDir, ...runtimeReadPaths]);
    const piHomeSource = await canonicalReviewPiHomeSource(defaultPiAgentDir());
    assertScratchBaseOutsideGrants(scratchBase, [piHomeSource]);
  }

  let controllerScratch: string | undefined;
  let packetPath: string | undefined;
  let candidateStorePath: string | undefined;

  try {
    workLog.record("deep_review_started", {
      runId,
      packetDigest: request.packet.packetDigest,
      headSha: request.packet.pullRequest.headSha,
      councilSize: request.config.council.length,
    });

    controllerScratch = await createReviewScratchDirectory(scratchBase);
    packetPath = path.join(controllerScratch, "packet.json");
    await writeFile(packetPath, `${JSON.stringify(request.packet)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises");
      await chmod(packetPath, 0o600);
    }

    const executor =
      request.actorExecutor ?? createDeepReviewActorExecutor({ config: request.config });

    const { workerOutcomes, candidates, candidateRecords, successfulMemberIds, workerDiagnostics } =
      await runCouncilWorkers({
        request,
        sourceDir,
        packetPath,
        scratchBase,
        executor,
        limits,
        workLog,
      });

    const successfulGroups = countSuccessfulIndependenceGroups(
      request.config.council.map((member) => ({
        memberId: member.id,
        model: member.model,
        independenceGroup: member.independenceGroup,
      })),
      successfulMemberIds,
    );
    workLog.record("quorum_evaluated", {
      successfulGroups,
      minimumSupport: computeMinimumSupport(request.config),
      quorumAvailable: quorumAvailable(request.config, successfulGroups),
    });

    let presidentOutcome: PresidentOutcomeV1;
    let publishableFindings: DeepReviewResultV1["publishableFindings"] = [];
    let artifactFindings: DeepReviewResultV1["artifactFindings"] = [];
    let diagnostics: DeepReviewResultV1["diagnostics"] = workerDiagnostics;
    let status: DeepReviewResultV1["status"] = "complete";
    let verdict: DeepReviewResultV1["verdict"] = "clean";

    if (!quorumAvailable(request.config, successfulGroups)) {
      presidentOutcome = failedPresidentOutcome(
        request.config.president,
        "not-run",
        `quorum-${runId}`,
      );
      diagnostics = [
        ...workerDiagnostics,
        diagnosticRecord(
          "deep-review-quorum-unavailable",
          "[DEEP_REVIEW_QUORUM_UNAVAILABLE] insufficient independent council results for president",
        ),
      ];
      status = "incomplete";
      verdict = "unavailable";
    } else {
      candidateStorePath = path.join(controllerScratch, "candidates.json");
      await writeCandidateStore(candidateStorePath, candidateRecords);

      const presidentScratch = await createReviewScratchDirectory(scratchBase);
      try {
        const presidentPrompt = buildPresidentPrompt(
          request.packet,
          [...candidates.entries()].map(([candidateId, record]) => ({
            candidateId,
            memberId: record.memberId,
          })),
        );
        workLog.record("president_started", {
          memberId: request.config.president.id,
          candidateCount: candidates.size,
        });
        const presidentOutput = await executor.runPresident({
          member: request.config.president,
          prompt: presidentPrompt,
          packetPath,
          candidateStorePath,
          sourceDir,
          actorScratchDir: presidentScratch,
          timeoutMs: limits.presidentTimeoutMs,
          maxOutputBytes: limits.maximumModelOutputBytes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const classification = classifyPresidentOutput({
          config: request.config,
          packet: request.packet,
          candidates,
          presidentOutput,
        });
        publishableFindings = classification.publishableFindings;
        artifactFindings = classification.artifactFindings;
        diagnostics = [...workerDiagnostics, ...classification.diagnostics];
        presidentOutcome = successfulPresidentOutcome(
          request.config.president,
          classification.clusterCount,
        );
        verdict = publishableFindings.length > 0 ? "findings" : "clean";
        workLog.record("president_completed", {
          memberId: request.config.president.id,
          clusterCount: classification.clusterCount,
          publishableFindingCount: publishableFindings.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusKind = message.includes("REVIEW_TIMEOUT")
          ? "timed-out"
          : message.includes("DEEP_REVIEW_OUTPUT_INVALID")
            ? "output-invalid"
            : "failed";
        presidentOutcome = failedPresidentOutcome(
          request.config.president,
          statusKind,
          `president-${runId}`,
        );
        diagnostics = [
          ...workerDiagnostics,
          diagnosticRecord("deep-review-president-failed", message),
        ];
        status = "incomplete";
        verdict = "unavailable";
        workLog.record("president_failed", {
          memberId: request.config.president.id,
          status: statusKind,
        });
      } finally {
        await rm(presidentScratch, { recursive: true, force: true });
      }
    }

    const result: DeepReviewResultV1 = {
      schemaVersion: "pioneer-deep-review-result/v1",
      runId,
      repository: request.packet.repository,
      pullRequest: { number: request.packet.pullRequest.number },
      packetDigest: request.packet.packetDigest,
      baseSha: request.packet.pullRequest.baseSha,
      headSha: request.packet.pullRequest.headSha,
      status,
      verdict,
      workers: workerOutcomes,
      president: presidentOutcome,
      publishableFindings,
      artifactFindings,
      diagnostics,
    };

    await persistDeepReviewResult({
      result,
      resultPath,
      ...(resultReservation === undefined ? {} : { reservation: resultReservation }),
    });
    resultReservation = undefined;
    workLog.record("result_persisted", {
      resultPath,
      status: result.status,
      verdict: result.verdict,
    });
    return { result, resultPath, workLogPath };
  } finally {
    if (resultReservation !== undefined) {
      await releaseReviewReportReservation(resultReservation).catch(() => {});
    }
    if (controllerScratch !== undefined) {
      await rm(controllerScratch, { recursive: true, force: true });
    }
    await workLog.close();
  }
}

interface WorkerExecutionPayload {
  readonly candidateIds: readonly string[];
  readonly records: readonly CandidateRecord[];
}

function mapWorkerOutcome(
  member: CouncilMemberV1,
  result: PromiseSettledResult<WorkerExecutionPayload>,
  diagnosticPrefix: string,
): WorkerOutcomeV1 {
  const outcome = settledWorkerOutcome(member, result, diagnosticPrefix);
  if (outcome.status === "success") {
    return {
      memberId: member.id,
      model: member.model,
      independenceGroup: member.independenceGroup,
      status: "success",
      candidateIds: outcome.candidateIds ?? [],
    };
  }
  return {
    memberId: member.id,
    model: member.model,
    independenceGroup: member.independenceGroup,
    status: outcome.status,
    diagnosticId: outcome.diagnosticId ?? `worker-${member.id}`,
  };
}

function workerFailureMessage(result: PromiseSettledResult<unknown>): string {
  if (result.status !== "rejected") return "worker failed";
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function workerDiagnosticsFromOutcomes(
  workerOutcomes: readonly WorkerOutcomeV1[],
  settled: readonly PromiseSettledResult<WorkerExecutionPayload>[],
): SafeDiagnosticV1[] {
  return workerOutcomes.flatMap((outcome, index) => {
    if (outcome.status === "success") return [];
    const diagnosticId = outcome.diagnosticId ?? `worker-${outcome.memberId}`;
    const settledResult = settled[index];
    if (settledResult === undefined) {
      return [diagnosticRecord(diagnosticId, "worker failed")];
    }
    return [diagnosticRecord(diagnosticId, workerFailureMessage(settledResult))];
  });
}

async function runCouncilWorkers(options: {
  readonly request: DeepReviewRequest;
  readonly sourceDir: string;
  readonly packetPath: string;
  readonly scratchBase: string;
  readonly executor: DeepReviewActorExecutor;
  readonly limits: ReturnType<typeof resolvedConfigLimits>;
  readonly workLog: Awaited<ReturnType<typeof openDeepReviewWorkLog>>;
}): Promise<{
  readonly workerOutcomes: WorkerOutcomeV1[];
  readonly candidates: ReadonlyMap<string, CandidateRecord>;
  readonly candidateRecords: readonly CandidateRecord[];
  readonly successfulMemberIds: ReadonlySet<string>;
  readonly workerDiagnostics: readonly SafeDiagnosticV1[];
}> {
  const workerPrompt = buildWorkerPrompt(options.request.packet);

  const tasks = options.request.config.council.map((member) => async () => {
    if (options.request.signal?.aborted) {
      throw new Error("[DEEP_REVIEW_WORKER_FAILED] deep review cancelled");
    }
    const actorScratchDir = await createReviewScratchDirectory(options.scratchBase);
    options.workLog.record("worker_started", { memberId: member.id, model: member.model });
    try {
      const output = await options.executor.runWorker({
        member,
        prompt: workerPrompt,
        packetPath: options.packetPath,
        sourceDir: options.sourceDir,
        actorScratchDir,
        timeoutMs: options.limits.workerTimeoutMs,
        maxOutputBytes: options.limits.maximumModelOutputBytes,
        ...(options.request.signal === undefined ? {} : { signal: options.request.signal }),
      });
      const payload = buildWorkerCandidatePayload(
        member,
        output,
        options.limits.maximumCandidatesPerWorker,
      );
      options.workLog.record("worker_completed", {
        memberId: member.id,
        candidateCount: payload.candidateIds.length,
      });
      return payload;
    } finally {
      await rm(actorScratchDir, { recursive: true, force: true });
    }
  });

  const settled = await runWithBoundedConcurrency(tasks, {
    maximumParallel: options.limits.maximumParallelWorkers,
    ...(options.request.signal === undefined ? {} : { signal: options.request.signal }),
  });

  const candidates = new Map<string, CandidateRecord>();
  const successfulMemberIds = new Set<string>();
  const workerOutcomes = options.request.config.council.map((member, index) => {
    const result = settled[index];
    if (result === undefined) {
      throw new Error("[DEEP_REVIEW_WORKER_FAILED] missing council worker result");
    }
    const outcome = mapWorkerOutcome(
      member,
      result,
      `worker-${options.request.packet.packetDigest}`,
    );
    if (result.status === "fulfilled") {
      successfulMemberIds.add(member.id);
      for (const record of result.value.records) {
        candidates.set(record.candidateId, record);
      }
    } else if (outcome.status !== "success") {
      options.workLog.record("worker_failed", {
        memberId: member.id,
        status: outcome.status,
        diagnosticId: outcome.diagnosticId,
      });
    }
    return outcome;
  });

  return {
    workerOutcomes,
    candidates,
    candidateRecords: [...candidates.values()],
    successfulMemberIds,
    workerDiagnostics: workerDiagnosticsFromOutcomes(workerOutcomes, settled),
  };
}

function buildWorkerCandidatePayload(
  member: CouncilMemberV1,
  output: WorkerOutputV1,
  maximumCandidates: number,
): WorkerExecutionPayload {
  if (output.findings.length > maximumCandidates) {
    throw new Error("[DEEP_REVIEW_OUTPUT_INVALID] worker findings exceed configured cap");
  }
  const records = output.findings.map((finding) => ({
    candidateId: computeCandidateId(member.id, finding),
    memberId: member.id,
    independenceGroup: member.independenceGroup,
    finding,
  }));
  return {
    candidateIds: records.map((record) => record.candidateId),
    records,
  };
}

async function writeCandidateStore(
  candidateStorePath: string,
  records: readonly CandidateRecord[],
): Promise<void> {
  await writeFile(candidateStorePath, `${JSON.stringify({ candidates: records })}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(candidateStorePath, 0o600);
  }
}
