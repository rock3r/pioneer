import { describe, expect, it } from "vitest";
import { settledWorkerOutcome } from "./council.js";

describe("settledWorkerOutcome", () => {
  const member = {
    id: "worker-a",
    model: "provider/model",
    independenceGroup: "group-a",
  };

  it("classifies Pioneer review timeouts as timed-out", () => {
    const outcome = settledWorkerOutcome(
      member,
      { status: "rejected", reason: new Error("[REVIEW_TIMEOUT] review exceeded 60000ms") },
      "worker",
    );
    expect(outcome.status).toBe("timed-out");
  });

  it("does not treat unrelated timeout wording as timed-out", () => {
    const outcome = settledWorkerOutcome(
      member,
      { status: "rejected", reason: new Error("network timeout while fetching") },
      "worker",
    );
    expect(outcome.status).toBe("failed");
  });
});
