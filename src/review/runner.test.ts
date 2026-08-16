import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultReviewReportDirectory } from "./resume-archive.js";
import {
  annotateHandledReviewResumeFailure,
  assertReviewResumeOutputsOutsideArchive,
  assertReviewResumeOutputsOutsideStorage,
  assertReviewResumeStateIsRecoverable,
  buildReviewPrompt,
  canonicalReviewPiHomeSource,
  cleanupCompletedReviewResumeArchive,
  cleanupUnavailableReviewResumeArchive,
  createReviewScratchDirectory,
  finalizeReviewWorkLog,
  markReviewCleanupFailure,
  pruneValidatedReviewResumeArchives,
  type ReviewRequest,
  readinessMetadataForWorkLog,
  requestedModelForWorkLog,
  requiresGitInspection,
  reviewResumeFailureKind,
  reviewTools,
  runReview,
  runReviewRpc,
  sendReviewPrompt,
  shouldHandleReviewResumeFailure,
  shouldSchedulePipeCloseFallback,
  sourcePathForWorkLog,
  validateProspectiveDefaultReviewOutputs,
} from "./runner.js";
import { type ReviewWorkLog, reviewWorkLogDirectory } from "./work-log.js";

function recordingWorkLog(): {
  readonly log: ReviewWorkLog;
  readonly records: Array<{ readonly type: string; readonly details: Record<string, unknown> }>;
} {
  const records: Array<{ readonly type: string; readonly details: Record<string, unknown> }> = [];
  return {
    records,
    log: {
      path: "/tmp/review.jsonl",
      runId: "run-1",
      record(type, details = {}) {
        records.push({ type, details: { ...details } });
      },
      close() {},
    },
  };
}

function fakePiRpc(events: readonly unknown[], exitCode = 0): readonly [string, ...string[]] {
  const source = `
process.stdin.once("data", () => {
  for (const event of ${JSON.stringify(events)}) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
  if (${exitCode} !== 0) process.stdout.end(() => process.exit(${exitCode}));
});
`;
  return [process.execPath, "-e", source];
}

function oversizedDeltaPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
process.stdin.once("data", () => {
  const delta = "x".repeat(128 * 1024);
  for (let index = 0; index < 33; index += 1) {
    process.stdout.write(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
    }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`,
  ];
}

function splitUtf8Pi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
process.stdin.once("data", () => {
  const output = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: "café" },
  }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n";
  const bytes = Buffer.from(output);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  process.stdout.write(bytes.subarray(0, split));
  process.stdout.write(bytes.subarray(split));
});
`,
  ];
}

function neverSettlingPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    "process.stdin.once('data', () => setInterval(() => {}, 1_000));",
  ];
}

function delayedExitPi(): readonly [string, ...string[]] {
  return [process.execPath, "-e", "setTimeout(() => process.exit(0), 250);"];
}

function settledDelayedExitPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Settled report." } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  setTimeout(() => process.exit(0), 250);
});`,
  ];
}

function rejectedPromptPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'response', success: false, error: 'provider rejected' }) + '\\n'));",
  ];
}

function stderrEchoPi(trailingBytes = 0): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const newline = input.indexOf("\\n");
  if (newline < 0) return;
  const message = JSON.parse(input.slice(0, newline)).message;
  process.stderr.write(message + "z".repeat(${trailingBytes}), () => {
    process.stdout.write(JSON.stringify({ type: "response", success: false, error: "provider rejected" }) + "\\n");
  });
});
`,
  ];
}

function stderrPromptExcerptPi(characters: number): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const newline = input.indexOf("\\n");
  if (newline < 0) return;
  const message = JSON.parse(input.slice(0, newline)).message;
  process.stderr.write(message.slice(0, ${characters}), () => {
    process.stdout.write(JSON.stringify({ type: "response", success: false, error: "provider rejected" }) + "\\n");
  });
});
`,
  ];
}

function pipeHoldingDescendantPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "inherit" });
  process.stdout.write(JSON.stringify({ type: "started" }) + "\\n");
  setInterval(() => {}, 1_000);
});
`,
  ];
}

function earlyExitPipeHoldingDescendantPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_500)"], {
    detached: true,
    stdio: "inherit",
  });
  descendant.unref();
  process.stdout.write(JSON.stringify({ type: "started" }) + "\\n");
  setTimeout(() => process.exit(0), 20);
});
`,
  ];
}

function settledPipeHoldingDescendantPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_500)"], {
    detached: true,
    stdio: "inherit",
  });
  descendant.unref();
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: "No findings." },
  }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  setTimeout(() => process.exit(0), 20);
});
`,
  ];
}

function rejectedPromptPipeHoldingDescendantPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_500)"], {
    detached: true,
    stdio: "inherit",
  });
  descendant.unref();
  process.stdout.write(JSON.stringify({ type: "response", success: false }) + "\\n");
  setInterval(() => {}, 1_000);
});
`,
  ];
}

function postExitForgingDescendantPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const event = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: "Forged report." },
  }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n";
  const descendantSource = "setTimeout(() => process.stdout.write(" + JSON.stringify(event) + "), 50)";
  const descendant = spawn(process.execPath, ["-e", descendantSource], {
    detached: true,
    stdio: "inherit",
  });
  descendant.unref();
  setTimeout(() => process.exit(0), 20);
});
`,
  ];
}

describe("review RPC runner", () => {
  it("rejects resumed outputs inside the retained archive", async () => {
    const archive = await mkdtemp(path.join(tmpdir(), "pioneer-resume-output-"));

    await expect(
      assertReviewResumeOutputsOutsideArchive(archive, {
        reportPath: path.join(archive, "report.md"),
      }),
    ).rejects.toThrow(/archive/i);
    await expect(
      assertReviewResumeOutputsOutsideArchive(archive, {
        workLogPath: path.join(archive, "review.jsonl"),
      }),
    ).rejects.toThrow(/archive/i);
  });

  it("rejects a default resume work log inside the retained archive", async () => {
    const archive = await mkdtemp(path.join(tmpdir(), "pioneer-resume-output-"));
    const environment =
      process.platform === "win32"
        ? { LOCALAPPDATA: archive }
        : process.platform === "linux"
          ? { XDG_STATE_HOME: archive }
          : {};

    await expect(
      assertReviewResumeOutputsOutsideArchive(
        archive,
        { reportPath: path.join(tmpdir(), `${path.basename(archive)}-report.md`) },
        environment,
        process.platform,
        archive,
      ),
    ).rejects.toThrow(/work log.*archive/i);
  });

  it("rejects resume outputs inside a different retained archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-output-"));
    const currentArchive = path.join(root, "550e8400-e29b-41d4-a716-446655440000");
    const otherArchive = path.join(root, "550e8400-e29b-41d4-a716-446655440001");
    await mkdir(currentArchive);
    await mkdir(otherArchive);

    await expect(
      assertReviewResumeOutputsOutsideStorage(
        { archiveDir: currentArchive },
        { reportPath: path.join(otherArchive, "report.md") },
      ),
    ).rejects.toThrow(/archive/i);
  });

  it("preserves a successful report while marking cleanup failure terminal", () => {
    const result = {
      report: "No findings.",
      sandboxed: true,
      warning: "Platform warning.",
      workLogPath: "/tmp/review.jsonl",
      reportPath: "/tmp/report.md",
    };

    expect(markReviewCleanupFailure(result)).toEqual({
      ...result,
      cleanupError:
        "[REVIEW_CLEANUP_FAILED] Pioneer completed the review, but cleanup did not fully succeed; inspect the controller work log.",
    });
  });

  it("turns completed archive deletion failure into deferred cleanup failure", async () => {
    let released = false;
    const failure = await cleanupCompletedReviewResumeArchive(
      {
        token: "550e8400-e29b-41d4-a716-446655440000",
        archiveDir: "/private/archive",
        attemptsDir: "/private/archive/attempts",
        activeAttemptDir: "/private/archive/attempts/0001",
      },
      async () => {
        throw new Error("archive delete failed");
      },
      async () => {
        released = true;
      },
    );

    expect(failure?.message).toBe("archive delete failed");
    expect(released).toBe(true);
  });

  it("reports deletion failure for an unavailable resume archive", async () => {
    const token = "550e8400-e29b-41d4-a716-446655440000";
    const failure = await cleanupUnavailableReviewResumeArchive(
      {
        token,
        archiveDir: `/private/${token}`,
        attemptsDir: `/private/${token}/attempts`,
        activeAttemptDir: `/private/${token}/attempts/0001`,
      },
      async () => {
        throw new Error(`EACCES: archive delete failed, rm '/private/${token}'`);
      },
    );

    expect(failure?.message).toBe(
      "[REVIEW_RESUME_DELETE_FAILED] Pioneer could not delete unavailable private review resume data; inspect the controller work log.",
    );
    expect(failure?.message).not.toContain(token);
    expect(failure?.message).not.toContain("/private/");
  });

  it("tracks handled resume failures without inspecting untrusted error text", () => {
    expect(shouldHandleReviewResumeFailure(false)).toBe(true);
    expect(shouldHandleReviewResumeFailure(true)).toBe(false);
  });

  it("does not classify diagnostic-looking caller text as a containment failure", () => {
    expect(
      reviewResumeFailureKind(
        new Error(
          "[REVIEW_WORK_LOG_WRITE_FAILED] /logs/[REVIEW_PROCESS_CONTAINMENT_FAILED]/review.jsonl",
        ),
      ),
    ).toBe("retainable");
  });

  it("preserves the recovery token after a later failure follows successful retention", () => {
    const token = "550e8400-e29b-41d4-a716-446655440000";
    expect(annotateHandledReviewResumeFailure(new Error("work log failed"), token).message).toBe(
      `work log failed\n[PIONEER_REVIEW_RESUME] ${token}`,
    );
  });

  it("rejects active archives whose prior actor may still be running", () => {
    expect(() => assertReviewResumeStateIsRecoverable("active")).toThrow(
      "[REVIEW_RESUME_NOT_READY]",
    );
    expect(() => assertReviewResumeStateIsRecoverable("retained")).not.toThrow();
    expect(() => assertReviewResumeStateIsRecoverable("report_delivery_failed")).not.toThrow();
  });

  it("canonicalizes the Pi home before freezing the resumable scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-pi-home-source-"));
    try {
      const target = path.join(root, "target");
      const alias = path.join(root, "alias");
      await mkdir(target);
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

      await expect(canonicalReviewPiHomeSource(alias)).resolves.toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a successful report when closing its work log fails", () => {
    const workLog: ReviewWorkLog = {
      path: "/tmp/review.jsonl",
      runId: "run-1",
      record() {},
      close() {
        throw new Error("sync failed");
      },
    };
    const result = {
      report: "No findings.",
      sandboxed: true,
      workLogPath: workLog.path,
      reportPath: "/tmp/report.md",
    };

    expect(finalizeReviewWorkLog(workLog, { result })).toEqual({
      ...result,
      workLogWriteError:
        "[REVIEW_WORK_LOG_WRITE_FAILED] Pioneer could not continue the real-time review work log at /tmp/review.jsonl: sync failed",
    });
  });

  it("preserves the primary diagnostic when closing a failed review log also fails", () => {
    const workLog: ReviewWorkLog = {
      path: "/tmp/review.jsonl",
      runId: "run-1",
      record() {},
      close() {
        throw new Error("sync failed");
      },
    };

    expect(() =>
      finalizeReviewWorkLog(workLog, {
        failure: new Error("[REVIEW_TIMEOUT] Pi timed out"),
      }),
    ).toThrow(
      "[REVIEW_TIMEOUT] Pi timed out\n[REVIEW_WORK_LOG_WRITE_FAILED] Pioneer could not continue the real-time review work log at /tmp/review.jsonl: sync failed",
    );
  });

  it("removes a newly created scratch directory when post-create work fails", async () => {
    let scratch: string | undefined;

    await expect(
      createReviewScratchDirectory(tmpdir(), (created) => {
        scratch = created;
        throw new Error("work log failed");
      }),
    ).rejects.toThrow(/work log failed/i);
    expect(scratch).toBeDefined();
    await expect(lstat(scratch ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the post-create failure when scratch cleanup also fails", async () => {
    let cleanupAttempted = false;

    await expect(
      createReviewScratchDirectory(
        tmpdir(),
        () => {
          throw new Error("work log failed");
        },
        async () => {
          cleanupAttempted = true;
          throw new Error("cleanup failed");
        },
      ),
    ).rejects.toThrow(/work log failed/i);
    expect(cleanupAttempted).toBe(true);
  });

  it("redacts and bounds the requested model before logging it", () => {
    expect(requestedModelForWorkLog("private review prompt", "private review prompt")).toBe(
      "[REDACTED]",
    );
    expect(requestedModelForWorkLog("Authorization: Bearer secret-token", "Review source")).toBe(
      "Authorization=[REDACTED]",
    );
    expect(requestedModelForWorkLog("x".repeat(600), "Review source")).toHaveLength(500);
  });

  it("redacts and bounds resolved Pi readiness metadata before logging it", () => {
    expect(
      readinessMetadataForWorkLog(
        { version: "token=private-version", resolvedModel: "x".repeat(600) },
        "Review source",
      ),
    ).toEqual({ piVersion: "token=[REDACTED]", model: "x".repeat(500) });
  });

  it("redacts and bounds the source path before logging it", () => {
    expect(sourcePathForWorkLog("/checkout/token=private/repo", "Review source")).toBe(
      "/checkout/token=[REDACTED]",
    );
    expect(sourcePathForWorkLog(`/${"x".repeat(600)}`, "Review source")).toHaveLength(500);
  });

  it("does not write the prompt after startup logging fails", () => {
    let written = false;
    const sent = sendReviewPrompt(
      {
        write() {
          written = true;
        },
      },
      "Review source",
      new Error("work log failed"),
    );

    expect(sent).toBe(false);
    expect(written).toBe(false);
  });

  it("does not schedule a pipe-close fallback after settlement", () => {
    expect(shouldSchedulePipeCloseFallback(true, false)).toBe(false);
    expect(shouldSchedulePipeCloseFallback(false, true)).toBe(false);
    expect(shouldSchedulePipeCloseFallback(false, false)).toBe(true);
  });

  it("does not classify unrelated request validation as a work-log creation failure", async () => {
    const sourceDir = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(tmpdir(), "pioneer-review-source-")),
    );

    await expect(
      runReview({
        sourceDir,
        prompt: "Review source",
        reportPath: "relative-review.md",
        ...(process.platform === "win32" ? { allowUnsandboxedWindows: true } : {}),
      }),
    ).rejects.toThrow(/^Review report path is not absolute:/);
  });

  it("rejects an invalid runtime network mode before opening a work log", async () => {
    const request = {
      sourceDir: "/not-reached",
      prompt: "Review source",
      network: "token=private-value",
    } as unknown as ReviewRequest;

    await expect(runReview(request)).rejects.toThrow(/network mode/i);
  });

  it("rejects an invalid runtime timeout before opening a work log", async () => {
    const request = {
      sourceDir: "/not-reached",
      prompt: "Review source",
      timeoutMs: "token=private-value",
    } as unknown as ReviewRequest;

    await expect(runReview(request)).rejects.toThrow(/timeout/i);
  });

  it("allows source discovery without granting macOS or Windows process tools", () => {
    expect(reviewTools("darwin")).toEqual(["read", "ls"]);
    expect(reviewTools("win32")).toEqual(["read", "ls"]);
    expect(reviewTools("linux")).toEqual(["read", "bash", "grep", "find", "ls"]);
  });

  it("does not inject controller-collected repository data into read-only reviews", () => {
    expect(buildReviewPrompt("/repo", "/scratch", "Review changes")).not.toContain("Git context");
  });

  it("does not persist a run-local scratch path in resumable review prompts", () => {
    expect(buildReviewPrompt("/repo", undefined, "Review changes")).not.toContain("Scratch:");
  });

  it("does not create or prune resume storage unless this run validated it", async () => {
    const root = path.join(
      await import("node:fs/promises").then(({ mkdtemp }) =>
        mkdtemp(path.join(tmpdir(), "pioneer-no-resume-")),
      ),
      "review-resumes",
    );

    await pruneValidatedReviewResumeArchives(false, root);

    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates both default outputs before either output directory is mutated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-default-output-preflight-"));
    const environment =
      process.platform === "win32"
        ? { LOCALAPPDATA: path.join(root, "data") }
        : { XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state") };
    const workLogDirectory = reviewWorkLogDirectory(environment, process.platform, root);
    const sourceDir = path.join(workLogDirectory, "source");
    const piHomeSource = path.join(root, "pi-home");
    const reportDirectory = defaultReviewReportDirectory(environment, process.platform, root);
    await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(piHomeSource)]);

    await expect(
      validateProspectiveDefaultReviewOutputs(
        { sourceDir, prompt: "Review source" },
        piHomeSource,
        environment,
        process.platform,
        root,
      ),
    ).rejects.toThrow(/work log.*actor-visible|controller directory.*overlaps/i);
    await expect(lstat(reportDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes Git-target requests that macOS and Windows cannot inspect", () => {
    expect(requiresGitInspection("Review only the staged changes.")).toBe(true);
    expect(requiresGitInspection("Review the untracked changes.")).toBe(true);
    expect(requiresGitInspection("Review the current changes.")).toBe(true);
    expect(requiresGitInspection("Review the code. Focus on the current changes.")).toBe(true);
    expect(
      requiresGitInspection("Review the code. Focus on the current working-tree changes."),
    ).toBe(true);
    expect(requiresGitInspection("Review the code. Focus on PR #42.")).toBe(true);
    expect(
      requiresGitInspection("Review the code. Focus on https://github.com/acme/app/pull/42."),
    ).toBe(true);
    expect(requiresGitInspection("Inspect commit abc1234.")).toBe(true);
    expect(requiresGitInspection("Review commit 1234567.")).toBe(true);
    expect(requiresGitInspection("Review commit `deadbeef`.")).toBe(true);
    expect(requiresGitInspection("Review commit HEAD~1.")).toBe(true);
    expect(requiresGitInspection("Review commit `main~1`. ")).toBe(true);
    expect(requiresGitInspection("Review HEAD.")).toBe(true);
    expect(requiresGitInspection("Review origin/main.")).toBe(true);
    expect(requiresGitInspection("Review origin/main for regressions.")).toBe(true);
    expect(requiresGitInspection("Review pull request #42.")).toBe(true);
    expect(requiresGitInspection("Review https://github.com/acme/app/pull/42.")).toBe(true);
    expect(requiresGitInspection("Review the last commit.")).toBe(true);
    expect(requiresGitInspection("Review the latest commit.")).toBe(true);
    expect(requiresGitInspection("Review the previous commit.")).toBe(true);
    expect(requiresGitInspection("Review the last commit carefully.")).toBe(true);
    expect(requiresGitInspection("Inspect the last commit, focusing on regressions.")).toBe(true);
    expect(requiresGitInspection("Review tag v1.2.3.")).toBe(true);
    expect(requiresGitInspection("Review tag latest.")).toBe(true);
    expect(requiresGitInspection("Inspect tag stable for regressions.")).toBe(true);
    expect(requiresGitInspection("Review tag parser-v2.")).toBe(true);
    expect(requiresGitInspection("Review commit `abc123` against its first parent.")).toBe(true);
    expect(requiresGitInspection("Review changes introduced by abc1234.")).toBe(true);
    expect(requiresGitInspection("Please review abc1234.")).toBe(true);
    expect(requiresGitInspection("Review changes since origin/main.")).toBe(true);
    expect(requiresGitInspection("Review changes since main.")).toBe(true);
    expect(requiresGitInspection("Review changes since `develop`. ")).toBe(true);
    expect(requiresGitInspection("Review the changes made since main.")).toBe(true);
    expect(requiresGitInspection("Compare this branch with origin/main.")).toBe(true);
    expect(requiresGitInspection("Review branch feature.")).toBe(true);
    expect(requiresGitInspection("Review branch feature for regressions.")).toBe(true);
    expect(requiresGitInspection("Review branch feature/login.")).toBe(true);
    expect(requiresGitInspection("Inspect branch `release/0.1`.")).toBe(true);
    expect(requiresGitInspection("Review changes against origin/main.")).toBe(true);
    expect(requiresGitInspection("Review changes against main.")).toBe(true);
    expect(requiresGitInspection("Review changes against `develop`.")).toBe(true);
    expect(requiresGitInspection("Review changes against release/next.")).toBe(true);
    expect(requiresGitInspection("Review changes between main and feature.")).toBe(true);
    expect(requiresGitInspection("Compare main...feature.")).toBe(true);
    expect(requiresGitInspection("Compare feature...main.")).toBe(true);
    expect(requiresGitInspection("Review main..feature.")).toBe(true);
    expect(requiresGitInspection("Compare origin/main..HEAD.")).toBe(true);
    expect(requiresGitInspection("Review the source for correctness.")).toBe(false);
    expect(requiresGitInspection("Review the source. PR #42 is background context.")).toBe(false);
    expect(
      requiresGitInspection(
        "Review the source. https://github.com/acme/app/pull/42 is background context.",
      ),
    ).toBe(false);
    expect(requiresGitInspection("Review the staged rollout implementation.")).toBe(false);
    expect(requiresGitInspection("Review the tag parser.")).toBe(false);
    expect(requiresGitInspection("Review the tag parser's behavior.")).toBe(false);
    expect(requiresGitInspection("Review tag handling: notes.")).toBe(false);
    expect(requiresGitInspection("Review the diff parser's branch selection.")).toBe(false);
    expect(requiresGitInspection("Review control-flow branch logic.")).toBe(false);
    expect(requiresGitInspection("Review this branch of the conditional for correctness.")).toBe(
      false,
    );
    expect(requiresGitInspection("Review changes between parser and renderer.")).toBe(false);
    expect(requiresGitInspection("Review changes between parser and main thread scheduling.")).toBe(
      false,
    );
    expect(requiresGitInspection("Inspect the branch to the retry path.")).toBe(false);
    expect(requiresGitInspection("Review commit message handling.")).toBe(false);
    expect(requiresGitInspection("Review last commit message handling.")).toBe(false);
    expect(requiresGitInspection("Review commit facade handling.")).toBe(false);
    expect(requiresGitInspection("Review commit headers.")).toBe(false);
    expect(requiresGitInspection("Review the implementation against the design document.")).toBe(
      false,
    );
    expect(requiresGitInspection("Review locking against main thread starvation.")).toBe(false);
    expect(requiresGitInspection("Review changes against main thread starvation.")).toBe(false);
    expect(requiresGitInspection("Review changes against masterful scheduling.")).toBe(false);
    expect(requiresGitInspection("Review changes against headless rendering.")).toBe(false);
    expect(requiresGitInspection("Review head for allocation issues.")).toBe(false);
    expect(requiresGitInspection("Please review ticket 123456.")).toBe(false);
    expect(requiresGitInspection("Compare these approaches...carefully.")).toBe(false);
  });

  it("returns the final assistant report after the RPC pipes close", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "No findings." }] },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        5_000,
      ),
    ).resolves.toBe("No findings.");
  });

  it("streams sanitized Pi lifecycle and tool metadata to the work log", async () => {
    const { log, records } = recordingWorkLog();
    const report = await runReviewRpc(
      fakePiRpc([
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "/private/source.ts" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "private finding" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "read",
          result: { content: [{ type: "text", text: "private source" }] },
          isError: false,
        },
        { type: "message_end", message: { role: "assistant", content: "No findings." } },
        { type: "agent_settled" },
      ]),
      process.cwd(),
      process.env,
      "Review secret prompt",
      1_000,
      { workLog: log },
    );

    expect(report).toBe("No findings.");
    expect(records.map(({ type }) => type)).toEqual([
      "pi_process_started",
      "pi_prompt_sent",
      "pi_event",
      "pi_event",
      "pi_event",
      "pi_event",
      "pi_event",
      "pi_event",
      "pi_process_exit",
      "pi_rpc_completed",
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("Review secret prompt");
    expect(serialized).not.toContain("/private/source.ts");
    expect(serialized).not.toContain("private source");
    expect(serialized).not.toContain("private finding");
    expect(serialized).toContain('"deltaBytes":15');
  });

  it("redacts the original user prompt from Pi event metadata", async () => {
    const { log, records } = recordingWorkLog();
    const userPrompt = "private user request";
    await runReviewRpc(
      fakePiRpc([
        { type: "tool_execution_start", toolCallId: "call-1", toolName: userPrompt },
        { type: "message_end", message: { role: "assistant", content: "No findings." } },
        { type: "agent_settled" },
      ]),
      process.cwd(),
      process.env,
      `Pioneer review instructions\n\nUser request:\n${userPrompt}`,
      1_000,
      { workLog: log, sensitiveValues: [userPrompt] },
    );

    expect(JSON.stringify(records)).not.toContain(userPrompt);
  });

  it("does not persist prompt excerpts from Pi failure diagnostics", async () => {
    const { log, records } = recordingWorkLog();
    const userPrompt = "Review confidential Project Falcon migration";

    let message = "";
    try {
      await runReviewRpc(
        fakePiRpc([{ type: "response", success: false, error: userPrompt.slice(0, 25) }]),
        process.cwd(),
        process.env,
        `Pioneer instructions\n\n${userPrompt}`,
        1_000,
        { workLog: log, sensitiveValues: [userPrompt] },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Pi RPC rejected the review prompt");
    expect(message).not.toContain("Project Falcon");
    expect(JSON.stringify(records)).not.toContain("Project Falcon");
  });

  it("redacts a long prompt echoed to stderr before retaining the diagnostic tail", async () => {
    const prompt = `private prompt ${"x".repeat(70 * 1024)}`;
    let message = "";
    try {
      await runReviewRpc(stderrEchoPi(), process.cwd(), process.env, prompt, 2_000);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("stderr: present");
    expect(message).not.toContain("private prompt");
    expect(message).not.toContain("x".repeat(100));
  });

  it("does not retain a split prompt fragment when later stderr exceeds the tail bound", async () => {
    const prompt = `private prompt ${"x".repeat(70 * 1024)}`;
    let message = "";
    try {
      await runReviewRpc(stderrEchoPi(66 * 1024), process.cwd(), process.env, prompt, 2_000);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("private prompt");
    expect(message).not.toContain("x".repeat(100));
    expect(message).toContain("stderr: present");
  });

  it("suppresses a prompt excerpt echoed to stderr", async () => {
    const prompt = "private Project Falcon prompt that continues beyond the excerpt";
    let message = "";
    try {
      await runReviewRpc(stderrPromptExcerptPi(30), process.cwd(), process.env, prompt, 2_000);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("stderr: present");
    expect(message).not.toContain(prompt.slice(0, 30));
    expect(message).not.toContain("Project Falcon");
  });

  it("emits real-time heartbeats while Pi is silent", async () => {
    const { log, records } = recordingWorkLog();
    await expect(
      runReviewRpc(neverSettlingPi(), process.cwd(), process.env, "Review the source", 45, {
        workLog: log,
        heartbeatMs: 10,
      }),
    ).rejects.toThrow("[REVIEW_TIMEOUT]");

    expect(records).toContainEqual({
      type: "heartbeat",
      details: expect.objectContaining({
        phase: "pi_rpc",
        lastPiEvent: "prompt_sent",
        idleMs: expect.any(Number),
      }),
    });
  });

  it("fails closed if the real-time work log stops accepting records", async () => {
    let writes = 0;
    const workLog: ReviewWorkLog = {
      path: "/tmp/review.jsonl",
      runId: "run-1",
      record() {
        writes += 1;
        if (writes === 2) throw new Error("disk full");
      },
      close() {},
    };

    await expect(
      runReviewRpc(neverSettlingPi(), process.cwd(), process.env, "Review the source", 1_000, {
        workLog,
      }),
    ).rejects.toThrow("[REVIEW_WORK_LOG_WRITE_FAILED]");
  });

  it("waits for child closure when startup failure termination stalls", async () => {
    const workLog: ReviewWorkLog = {
      path: "/tmp/review.jsonl",
      runId: "run-1",
      record() {
        throw new Error("disk full");
      },
      close() {},
    };
    const startedAt = Date.now();

    await expect(
      runReviewRpc(delayedExitPi(), process.cwd(), process.env, "Review the source", 1_000, {
        workLog,
        terminateProcess() {},
        escalateProcess() {},
        startupFailureGraceMs: 10,
      }),
    ).rejects.toThrow("[REVIEW_WORK_LOG_WRITE_FAILED]");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("allows a settled report a bounded close grace period", async () => {
    await expect(
      runReviewRpc(settledDelayedExitPi(), process.cwd(), process.env, "Review the source", 200),
    ).resolves.toBe("Settled report.");
  });

  it("collects delta-only message updates from Pi 0.84", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "No " },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "findings." },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        5_000,
      ),
    ).resolves.toBe("No findings.");
  });

  it("rejects a failed assistant reported by a delta-only update", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_update",
            message: { role: "assistant", stopReason: "error" },
            assistantMessageEvent: { type: "text_delta", delta: "Partial review" },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_ASSISTANT_FAILED]");
  });

  it("rejects cumulative RPC output above the selected limit with a stable diagnostic", async () => {
    await expect(
      runReviewRpc(oversizedDeltaPi(), process.cwd(), process.env, "Review the source", 5_000, {
        maxRpcOutputBytes: 1 * 1024 * 1024,
      }),
    ).rejects.toThrow("[REVIEW_RPC_OUTPUT_LIMIT] Pi RPC output exceeded the 1 MiB limit");
  });

  it("preserves UTF-8 split across RPC stdout chunks", async () => {
    await expect(
      runReviewRpc(splitUtf8Pi(), process.cwd(), process.env, "Review the source", 5_000),
    ).resolves.toBe("café");
  });

  it("rejects a settled process that emits no report", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([{ type: "agent_settled" }]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_REPORT_MISSING]");
  });

  it("rejects a settled report when Pi exits nonzero", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc(
          [
            {
              type: "message_end",
              message: { role: "assistant", content: "Partial report" },
            },
            { type: "agent_settled" },
          ],
          2,
        ),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_PROCESS_FAILED]");
  });

  it.each([
    {
      type: "turn_end",
      message: { role: "assistant", content: "Partial review", stopReason: "error" },
    },
    {
      type: "agent_end",
      messages: [{ role: "assistant", content: "Partial review", stopReason: "aborted" }],
    },
  ])("rejects failed assistant output from $type", async (event) => {
    await expect(
      runReviewRpc(
        fakePiRpc([event, { type: "agent_settled" }]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_ASSISTANT_FAILED]");
  });

  it("accepts a successful retry after an earlier assistant error", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: { role: "assistant", content: "Partial review", stopReason: "error" },
          },
          {
            type: "message_end",
            message: { role: "assistant", content: "No findings.", stopReason: "stop" },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).resolves.toBe("No findings.");
  });

  it("accepts a length-limited retry after an earlier assistant error", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: { role: "assistant", content: "Partial review", stopReason: "error" },
          },
          {
            type: "message_end",
            message: { role: "assistant", content: "No findings.", stopReason: "length" },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).resolves.toBe("No findings.");
  });

  it.each([
    {
      type: "message_end",
      message: { role: "assistant", content: "", stopReason: "stop" },
    },
    {
      type: "turn_end",
      message: { role: "assistant", content: "", stopReason: "stop" },
    },
    {
      type: "agent_end",
      messages: [{ role: "assistant", content: "", stopReason: "stop" }],
    },
  ])("rejects stale output after an empty successful retry via $type", async (successEvent) => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: { role: "assistant", content: "Partial review", stopReason: "error" },
          },
          successEvent,
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_REPORT_MISSING]");
  });

  it("rejects stale output after an empty array-form successful retry", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: { role: "assistant", content: "Partial review", stopReason: "error" },
          },
          {
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "stop" },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_REPORT_MISSING]");
  });

  it("rejects stale output after a content-less successful retry", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: { role: "assistant", content: "Partial review", stopReason: "error" },
          },
          {
            type: "message_end",
            message: { role: "assistant", stopReason: "stop" },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_REPORT_MISSING]");
  });

  it("rejects a delta-only stream with an assistant event error", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Partial review" },
          },
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "provider failed",
              },
            },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_ASSISTANT_FAILED]");
  });

  it("redacts provider and prompt secrets from assistant failure diagnostics", async () => {
    let message = "";
    try {
      await runReviewRpc(
        fakePiRpc([
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                stopReason: "error",
                errorMessage:
                  "Authorization: Bearer provider-secret while processing private prompt",
              },
            },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "private prompt",
        1_000,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("diagnostics: 1");
    expect(message).not.toContain("provider-secret");
    expect(message).not.toContain("private prompt");
  });

  it("suppresses an upstream-truncated prompt excerpt from assistant diagnostics", async () => {
    const longPrompt = `private prompt ${"x".repeat(700)}`;
    let message = "";
    try {
      await runReviewRpc(
        fakePiRpc([
          {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: longPrompt.slice(0, 400),
            },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        longPrompt,
        1_000,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("diagnostics: 1");
    expect(message).not.toContain("private prompt");
    expect(message).not.toContain("x".repeat(100));
  });

  it("returns only a successful retry from a delta-only stream", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "message_update",
            assistantMessageEvent: { type: "start" },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Partial review" },
          },
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "provider failed",
              },
            },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "start" },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "No findings." },
          },
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "done",
              reason: "stop",
              message: { role: "assistant", content: "No findings.", stopReason: "stop" },
            },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).resolves.toBe("No findings.");
  });

  it("accepts a delta-only retry that settles without a done event", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          { type: "message_update", assistantMessageEvent: { type: "start" } },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Partial review" },
          },
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "error",
              reason: "error",
              error: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
            },
          },
          { type: "message_update", assistantMessageEvent: { type: "start" } },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "No findings." },
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).resolves.toBe("No findings.");
  });

  it("rejects an agent_end whose newest assistant response failed", async () => {
    await expect(
      runReviewRpc(
        fakePiRpc([
          {
            type: "agent_end",
            messages: [
              { role: "assistant", content: "No findings.", stopReason: "stop" },
              { role: "assistant", stopReason: "error", errorMessage: "retry failed" },
            ],
          },
          { type: "agent_settled" },
        ]),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      ),
    ).rejects.toThrow("[REVIEW_ASSISTANT_FAILED]");
  });

  it("rejects a process that exits before Pi settles", async () => {
    await expect(
      runReviewRpc(fakePiRpc([], 2), process.cwd(), process.env, "Review the source", 1_000),
    ).rejects.toThrow("[REVIEW_RPC_INCOMPLETE]");
  });

  it.skipIf(process.platform === "win32")(
    "rejects RPC events emitted by a descendant after the Pi child exits",
    async () => {
      await expect(
        runReviewRpc(
          postExitForgingDescendantPi(),
          process.cwd(),
          process.env,
          "Review the source",
          1_000,
        ),
      ).rejects.toThrow("[REVIEW_RPC_INCOMPLETE]");
    },
  );

  it("waits for the timed-out Pi child to close before reporting its final termination state", async () => {
    await expect(
      runReviewRpc(neverSettlingPi(), process.cwd(), process.env, "Review the source", 10),
    ).rejects.toThrow(/\[REVIEW_TIMEOUT\].*exit .*signal (?:SIGKILL|none)/s);
  });

  it("includes the final child termination state for a rejected prompt", async () => {
    let failure: Error | undefined;
    try {
      await runReviewRpc(
        rejectedPromptPi(),
        process.cwd(),
        process.env,
        "Review the source",
        1_000,
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure?.message).toMatch(
      /Pi RPC rejected the review prompt .*exit .*signal (?:SIGKILL|none)/s,
    );
    expect(failure === undefined ? undefined : reviewResumeFailureKind(failure)).toBe(
      "prompt_rejected",
    );
  });

  it("terminates the isolated child tree when Pioneer receives SIGINT", async () => {
    const review = runReviewRpc(
      neverSettlingPi(),
      process.cwd(),
      process.env,
      "Review the source",
      1_000,
    );
    setTimeout(() => process.emit("SIGINT"), 10);
    await expect(review).rejects.toThrow("Pi review interrupted by SIGINT");
  });

  it.skipIf(process.platform === "win32")(
    "kills a pipe-holding descendant instead of waiting for it after timeout",
    async () => {
      const started = performance.now();
      await expect(
        runReviewRpc(
          pipeHoldingDescendantPi(),
          process.cwd(),
          process.env,
          "Review the source",
          100,
        ),
      ).rejects.toThrow("[REVIEW_TIMEOUT]");
      expect(performance.now() - started).toBeLessThan(500);
    },
  );

  it.skipIf(process.platform === "win32")(
    "bounds an escaped descendant after the direct child exits before timeout",
    async () => {
      const started = performance.now();
      await expect(
        runReviewRpc(
          earlyExitPipeHoldingDescendantPi(),
          process.cwd(),
          process.env,
          "Review the source",
          500,
        ),
      ).rejects.toThrow("[REVIEW_PROCESS_CONTAINMENT_FAILED]");
      expect(performance.now() - started).toBeLessThan(1_400);
    },
    3_000,
  );

  it.skipIf(process.platform === "win32")(
    "rejects a settled report when an escaped descendant retains an output pipe",
    async () => {
      const started = performance.now();
      const review = runReviewRpc(
        settledPipeHoldingDescendantPi(),
        process.cwd(),
        process.env,
        "Review the source",
        500,
      );
      setTimeout(() => process.emit("SIGINT"), 250);
      await expect(review).rejects.toThrow("[REVIEW_PROCESS_CONTAINMENT_FAILED]");
      expect(performance.now() - started).toBeLessThan(1_400);
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "classifies containment loss ahead of an earlier terminal RPC failure",
    async () => {
      let failure: Error | undefined;
      try {
        await runReviewRpc(
          rejectedPromptPipeHoldingDescendantPi(),
          process.cwd(),
          process.env,
          "Review the source",
          500,
        );
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }

      expect(failure?.message).toContain("[REVIEW_PROCESS_CONTAINMENT_FAILED]");
      expect(failure === undefined ? undefined : reviewResumeFailureKind(failure)).toBe(
        "containment",
      );
    },
    5_000,
  );
});
