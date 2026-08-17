import { describe, expect, it } from "vitest";
import { REVIEW_USAGE } from "./review-cli-usage.js";

describe("review CLI help", () => {
  it("documents the resumable review form and its allowed overrides", () => {
    expect(REVIEW_USAGE).toContain("pioneer review --resume TOKEN");
    expect(REVIEW_USAGE).toContain("[--timeout-ms N]");
    expect(REVIEW_USAGE).toContain("[--max-rpc-output-mb N]");
    expect(REVIEW_USAGE).toContain("[--allow-unsandboxed-windows]");
  });
});
