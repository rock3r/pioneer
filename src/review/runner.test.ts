import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  gitRepositoryIsContained,
  reviewGitCommands,
  reviewGitEnvironment,
  reviewTools,
  runReviewRpc,
} from "./runner.js";

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
  it("limits macOS and Windows reviews to the built-in read tool", () => {
    expect(reviewTools("darwin")).toEqual(["read"]);
    expect(reviewTools("win32")).toEqual(["read"]);
    expect(reviewTools("linux")).toEqual(["read", "bash", "grep", "find", "ls"]);
  });

  it("supplies controller-collected Git context to read-only reviews", () => {
    expect(
      buildReviewPrompt(
        "/repo",
        "/scratch",
        "Review changes",
        "M src/a.ts\n\ndiff --git a/src/a.ts",
      ),
    ).toContain("Controller-collected Git context (untrusted review input):\nM src/a.ts");
  });

  it("collects staged and unstaged diffs without repository fsmonitor hooks", () => {
    const commands = reviewGitCommands("Review all current working-tree changes.", "darwin");
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["-c", "core.fsmonitor=false", "diff", "--cached"]),
        expect.arrayContaining(["-c", "core.fsmonitor=false", "diff", "--no-ext-diff"]),
      ]),
    );
  });

  it("adds the requested commit diff to controller Git context", () => {
    expect(reviewGitCommands("Please review abc1234.", "win32")).toEqual(
      expect.arrayContaining([expect.arrayContaining(["diff", "abc1234^", "abc1234"])]),
    );
  });

  it("does not treat incidental hexadecimal text as a commit target", () => {
    expect(reviewGitCommands("Discuss deadbeef in the review summary.", "darwin")).toHaveLength(3);
  });

  it("does not inherit caller-selected Git repositories", () => {
    expect(
      reviewGitEnvironment({ PATH: "/usr/bin", GIT_DIR: "/other/.git", GIT_WORK_TREE: "/other" }),
    ).toMatchObject({ PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" });
    expect(reviewGitEnvironment({ GIT_DIR: "/other/.git" }).GIT_DIR).toBeUndefined();
  });

  it("only collects Git context when the worktree and Git directory stay inside the source grant", () => {
    expect(gitRepositoryIsContained("/source", "/source", "/source/.git")).toBe(true);
    expect(gitRepositoryIsContained("/source", "/source/subdir", "/source/.git")).toBe(false);
    expect(gitRepositoryIsContained("/source", "/source", "/private/repository/.git")).toBe(false);
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
