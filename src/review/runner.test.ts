import { describe, expect, it } from "vitest";
import { buildReviewPrompt, requiresGitInspection, reviewTools, runReviewRpc } from "./runner.js";

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

function neverSettlingPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    "process.stdin.once('data', () => setInterval(() => {}, 1_000));",
  ];
}

function rejectedPromptPi(): readonly [string, ...string[]] {
  return [
    process.execPath,
    "-e",
    "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'response', success: false, error: 'provider rejected' }) + '\\n'));",
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

describe("review RPC runner", () => {
  it("allows source discovery without granting macOS or Windows process tools", () => {
    expect(reviewTools("darwin")).toEqual(["read", "ls"]);
    expect(reviewTools("win32")).toEqual(["read", "ls"]);
    expect(reviewTools("linux")).toEqual(["read", "bash", "grep", "find", "ls"]);
  });

  it("does not inject controller-collected repository data into read-only reviews", () => {
    expect(buildReviewPrompt("/repo", "/scratch", "Review changes")).not.toContain("Git context");
  });

  it("recognizes Git-target requests that macOS and Windows cannot inspect", () => {
    expect(requiresGitInspection("Review only the staged changes.")).toBe(true);
    expect(requiresGitInspection("Review the current changes.")).toBe(true);
    expect(requiresGitInspection("Inspect commit abc1234.")).toBe(true);
    expect(requiresGitInspection("Review commit 1234567.")).toBe(true);
    expect(requiresGitInspection("Review commit HEAD~1.")).toBe(true);
    expect(requiresGitInspection("Review commit `abc123` against its first parent.")).toBe(true);
    expect(requiresGitInspection("Review changes introduced by abc1234.")).toBe(true);
    expect(requiresGitInspection("Please review abc1234.")).toBe(true);
    expect(requiresGitInspection("Review changes since origin/main.")).toBe(true);
    expect(requiresGitInspection("Compare this branch with origin/main.")).toBe(true);
    expect(requiresGitInspection("Review branch feature.")).toBe(true);
    expect(requiresGitInspection("Review branch feature for regressions.")).toBe(true);
    expect(requiresGitInspection("Review branch feature/login.")).toBe(true);
    expect(requiresGitInspection("Inspect branch `release/0.1`.")).toBe(true);
    expect(requiresGitInspection("Review changes against origin/main.")).toBe(true);
    expect(requiresGitInspection("Review changes against main.")).toBe(true);
    expect(requiresGitInspection("Review changes between main and feature.")).toBe(true);
    expect(requiresGitInspection("Compare main...feature.")).toBe(true);
    expect(requiresGitInspection("Compare feature...main.")).toBe(true);
    expect(requiresGitInspection("Review main..feature.")).toBe(true);
    expect(requiresGitInspection("Compare origin/main..HEAD.")).toBe(true);
    expect(requiresGitInspection("Review the source for correctness.")).toBe(false);
    expect(requiresGitInspection("Review the diff parser's branch selection.")).toBe(false);
    expect(requiresGitInspection("Review control-flow branch logic.")).toBe(false);
    expect(requiresGitInspection("Review changes between parser and renderer.")).toBe(false);
    expect(requiresGitInspection("Review changes between parser and main thread scheduling.")).toBe(
      false,
    );
    expect(requiresGitInspection("Inspect the branch to the retry path.")).toBe(false);
    expect(requiresGitInspection("Review commit message handling.")).toBe(false);
    expect(requiresGitInspection("Review commit facade handling.")).toBe(false);
    expect(requiresGitInspection("Review commit headers.")).toBe(false);
    expect(requiresGitInspection("Review the implementation against the design document.")).toBe(
      false,
    );
    expect(requiresGitInspection("Review locking against main thread starvation.")).toBe(false);
    expect(requiresGitInspection("Review changes against main thread starvation.")).toBe(false);
    expect(requiresGitInspection("Review changes against masterful scheduling.")).toBe(false);
    expect(requiresGitInspection("Review changes against headless rendering.")).toBe(false);
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
        1_000,
      ),
    ).resolves.toBe("No findings.");
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

  it("rejects a process that exits before Pi settles", async () => {
    await expect(
      runReviewRpc(fakePiRpc([], 2), process.cwd(), process.env, "Review the source", 1_000),
    ).rejects.toThrow("[REVIEW_RPC_INCOMPLETE]");
  });

  it("waits for the timed-out Pi child to close before reporting its final termination state", async () => {
    await expect(
      runReviewRpc(neverSettlingPi(), process.cwd(), process.env, "Review the source", 10),
    ).rejects.toThrow(/\[REVIEW_TIMEOUT\].*exit .*signal (?:SIGKILL|none)/s);
  });

  it("includes the final child termination state for a rejected prompt", async () => {
    await expect(
      runReviewRpc(rejectedPromptPi(), process.cwd(), process.env, "Review the source", 1_000),
    ).rejects.toThrow(
      /Pi RPC rejected the review prompt: provider rejected .*exit .*signal (?:SIGKILL|none)/s,
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
          100,
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
});
