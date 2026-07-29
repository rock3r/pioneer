import { describe, expect, it } from "vitest";
import { runReviewRpc } from "./runner.js";

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

describe("review RPC runner", () => {
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
    ).rejects.toThrow(/\[REVIEW_TIMEOUT\].*exit .*signal SIGKILL/s);
  });

  it("includes the final child termination state for a rejected prompt", async () => {
    await expect(
      runReviewRpc(rejectedPromptPi(), process.cwd(), process.env, "Review the source", 1_000),
    ).rejects.toThrow(
      /Pi RPC rejected the review prompt: provider rejected .*exit .*signal SIGKILL/s,
    );
  });
});
