import { describe, expect, it } from "vitest";
import { buildReviewPrompt, requiresGitInspection, reviewTools, runReviewRpc } from "./runner.js";
import type { ReviewWorkLog } from "./work-log.js";

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

  it("rejects cumulative RPC output above 4 MiB", async () => {
    await expect(
      runReviewRpc(oversizedDeltaPi(), process.cwd(), process.env, "Review the source", 5_000),
    ).rejects.toThrow("Pi RPC output exceeded 4 MiB");
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
});
