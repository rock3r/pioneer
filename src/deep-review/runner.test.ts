import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { parseDeepReviewConfig } from "./config.js";
import type { PresidentOutputV1, WorkerFindingV1, WorkerOutputV1 } from "./finding.js";
import { computeCandidateId } from "./ids.js";
import type { PullRequestPacketV1 } from "./packet.js";
import { computePacketDigest } from "./packet.js";
import { assertDeepReviewPlatform, type DeepReviewActorExecutor, runDeepReview } from "./runner.js";

const temp = registerManagedTempPaths();

const sampleFinding = (): WorkerFindingV1 => ({
  file: "src/main.ts",
  line: 2,
  endLine: 2,
  side: "RIGHT",
  severity: "high",
  category: "correctness",
  title: "Null dereference",
  summary: "Possible null access",
  evidence: "Line 2 accesses x without check",
  whyItMatters: "Runtime crash",
  suggestedFix: "Add null check",
  confidence: "high",
  dedupeKey: "null-deref-main",
});

function samplePacket(): PullRequestPacketV1 {
  const body = {
    schemaVersion: "pioneer-pr-review-packet/v1" as const,
    repository: { owner: "acme", name: "repo" },
    pullRequest: {
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
      title: "Fix",
      body: "",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    commits: [],
    files: [
      {
        path: "src/main.ts",
        status: "modified" as const,
        contentKind: "text" as const,
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
      },
    ],
    rules: [],
    previousFindings: [],
  };
  return { ...body, packetDigest: computePacketDigest(body) };
}

const baseConfig = parseDeepReviewConfig({
  schemaVersion: "pioneer-deep-review-config/v1",
  council: [
    { id: "worker-a", model: "provider/a", independenceGroup: "group-a" },
    { id: "worker-b", model: "provider/b", independenceGroup: "group-b" },
  ],
  president: { id: "president", model: "provider/p", independenceGroup: "group-p" },
});

function workerOutput(findings: readonly WorkerFindingV1[] = [sampleFinding()]): WorkerOutputV1 {
  return {
    schemaVersion: "pioneer-pr-review-worker/v1",
    findings,
  };
}

function presidentOutput(
  candidateIds: readonly string[],
  finding: WorkerFindingV1 = sampleFinding(),
): PresidentOutputV1 {
  return {
    schemaVersion: "pioneer-pr-review-president/v1",
    clusters: [
      {
        disposition: "accept",
        candidateIds: [...candidateIds],
        reason: "consensus-supported",
        rationale: "Both agree",
        normalizedFinding: finding,
        presidentConfidence: "high",
        stableDedupeKey: finding.dedupeKey,
      },
    ],
  };
}

function createFakeExecutor(options?: {
  readonly workerDelayMs?: number;
  readonly failMemberId?: string;
  readonly presidentOutput?: PresidentOutputV1;
}): DeepReviewActorExecutor {
  const startedAt = new Map<string, number>();
  return {
    async runWorker(request) {
      startedAt.set(request.member.id, Date.now());
      if (options?.workerDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.workerDelayMs));
      }
      if (request.member.id === options?.failMemberId) {
        throw new Error("[DEEP_REVIEW_WORKER_FAILED] injected failure");
      }
      return workerOutput();
    },
    async runPresident(request) {
      const store = JSON.parse(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(request.candidateStorePath, "utf8"),
        ),
      ) as { candidates: Array<{ candidateId: string }> };
      const candidateIds = store.candidates.map((candidate) => candidate.candidateId);
      return options?.presidentOutput ?? presidentOutput(candidateIds);
    },
  };
}

describe("runDeepReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects Windows before actor launch", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(() => assertDeepReviewPlatform(baseConfig)).toThrow(/unsupported on Windows/);
  });

  it("rejects focusedCommands until Slice 10 ships", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(() =>
      assertDeepReviewPlatform({
        ...baseConfig,
        focusedCommands: {
          platform: "linux",
          commands: [],
          maximumInvocations: 0,
          timeoutMsPerInvocation: 1_000,
          maximumOutputBytesPerInvocation: 1_024,
        },
      }),
    ).toThrow(/focusedCommands execution is disabled/);
  });

  it("assigns candidate IDs and publishes consensus findings with fake actors", async () => {
    const sourceDir = await temp.createTempDir("deep-review-source-");
    await writeFile(path.join(sourceDir, "README.md"), "demo\n", "utf8");
    const resultPath = temp.reserveTempPath(`deep-review-result-${Date.now()}.json`);
    const workLogPath = temp.reserveTempPath(`deep-review-log-${Date.now()}.jsonl`);

    const execution = await runDeepReview({
      sourceDir,
      packet: samplePacket(),
      config: baseConfig,
      resultPath,
      workLogPath,
      actorExecutor: createFakeExecutor(),
    });

    expect(execution.result.status).toBe("complete");
    expect(execution.result.verdict).toBe("findings");
    expect(execution.result.workers.every((worker) => worker.status === "success")).toBe(true);
    expect(execution.result.president.status).toBe("success");
    expect(execution.result.publishableFindings).toHaveLength(1);

    const finding = sampleFinding();
    const expectedIds = [
      computeCandidateId("worker-a", finding),
      computeCandidateId("worker-b", finding),
    ];
    expect(
      execution.result.workers[0]?.status === "success" && execution.result.workers[0].candidateIds,
    ).toEqual([expectedIds[0]]);
    expect(
      execution.result.workers[1]?.status === "success" && execution.result.workers[1].candidateIds,
    ).toEqual([expectedIds[1]]);
  });

  it("skips president when quorum is unavailable", async () => {
    const sourceDir = await temp.createTempDir("deep-review-source-");
    await writeFile(path.join(sourceDir, "README.md"), "demo\n", "utf8");
    const resultPath = temp.reserveTempPath(`deep-review-result-${Date.now()}.json`);
    const workLogPath = temp.reserveTempPath(`deep-review-log-${Date.now()}.jsonl`);

    const execution = await runDeepReview({
      sourceDir,
      packet: samplePacket(),
      config: baseConfig,
      resultPath,
      workLogPath,
      actorExecutor: createFakeExecutor({ failMemberId: "worker-b" }),
    });

    expect(execution.result.status).toBe("incomplete");
    expect(execution.result.verdict).toBe("unavailable");
    expect(execution.result.president.status).toBe("not-run");
    expect(execution.result.publishableFindings).toHaveLength(0);
    expect(
      execution.result.diagnostics.some((entry) => entry.id === "deep-review-quorum-unavailable"),
    ).toBe(true);
    const failedWorker = execution.result.workers.find((worker) => worker.memberId === "worker-b");
    expect(failedWorker?.status).toBe("failed");
    if (failedWorker?.status !== "failed") throw new Error("expected failed worker");
    expect(failedWorker.diagnosticId).toBeDefined();
    expect(
      execution.result.diagnostics.some((entry) => entry.id === failedWorker.diagnosticId),
    ).toBe(true);

    const workLogText = await readFile(workLogPath, "utf8");
    const records = workLogText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; details: { memberId?: string } });
    expect(
      records.some(
        (record) => record.type === "worker_failed" && record.details.memberId === "worker-b",
      ),
    ).toBe(true);
  });

  it("schedules council workers with bounded concurrency", async () => {
    const threeMemberConfig = parseDeepReviewConfig({
      schemaVersion: "pioneer-deep-review-config/v1",
      council: [
        { id: "worker-a", model: "provider/a", independenceGroup: "group-a" },
        { id: "worker-b", model: "provider/b", independenceGroup: "group-b" },
        { id: "worker-c", model: "provider/c", independenceGroup: "group-c" },
      ],
      president: { id: "president", model: "provider/p", independenceGroup: "group-p" },
      limits: { maximumParallelWorkers: 2 },
    });

    let active = 0;
    let maxActive = 0;
    const executor: DeepReviewActorExecutor = {
      async runWorker(_request) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return workerOutput();
      },
      async runPresident(request) {
        const { readFile } = await import("node:fs/promises");
        const store = JSON.parse(await readFile(request.candidateStorePath, "utf8")) as {
          candidates: Array<{ candidateId: string }>;
        };
        const firstTwo = store.candidates.slice(0, 2).map((candidate) => candidate.candidateId);
        return presidentOutput(firstTwo);
      },
    };

    const sourceDir = await temp.createTempDir("deep-review-source-");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "README.md"), "demo\n", "utf8");

    await runDeepReview({
      sourceDir,
      packet: samplePacket(),
      config: threeMemberConfig,
      resultPath: temp.reserveTempPath(`deep-review-result-${Date.now()}.json`),
      workLogPath: temp.reserveTempPath(`deep-review-log-${Date.now()}.jsonl`),
      actorExecutor: executor,
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("rejects a scratch base inside the reviewed source tree", async () => {
    const sourceDir = await temp.createTempDir("deep-review-source-");
    await writeFile(path.join(sourceDir, "README.md"), "demo\n", "utf8");

    await expect(
      runDeepReview({
        sourceDir,
        packet: samplePacket(),
        config: baseConfig,
        controllerScratchBase: sourceDir,
        resultPath: temp.reserveTempPath(`deep-review-result-${Date.now()}.json`),
        workLogPath: temp.reserveTempPath(`deep-review-log-${Date.now()}.jsonl`),
        actorExecutor: createFakeExecutor(),
      }),
    ).rejects.toThrow(/Controller scratch base must not sit inside a granted path/);
  });

  it("rejects actor-visible result and work-log targets", async () => {
    const sourceDir = await temp.createTempDir("deep-review-source-");
    await writeFile(path.join(sourceDir, "README.md"), "demo\n", "utf8");
    const resultPath = path.join(sourceDir, "result.json");
    const workLogPath = temp.reserveTempPath(`deep-review-log-${Date.now()}.jsonl`);

    await expect(
      runDeepReview({
        sourceDir,
        packet: samplePacket(),
        config: baseConfig,
        resultPath,
        workLogPath,
        actorExecutor: createFakeExecutor(),
      }),
    ).rejects.toThrow(/actor-visible/);
  });
});
