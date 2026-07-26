import { describe, expect, it } from "vitest";
import { runReviewRpc } from "./runner.js";

function fakePiRpc(events: readonly unknown[]): readonly [string, ...string[]] {
  const source = `
process.stdin.once("data", () => {
  for (const event of ${JSON.stringify(events)}) {
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
});
`;
  return [process.execPath, "-e", source];
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
});
