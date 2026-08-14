import { describe, expect, it } from "vitest";
import { parseReviewCliArgs } from "./review-cli-args.js";

describe("review CLI arguments", () => {
  it("parses repeated Pi-home includes without resolving them against the caller", () => {
    expect(
      parseReviewCliArgs([
        "--source",
        ".",
        "--prompt",
        "Review it",
        "--pi-home",
        "/tmp/pi",
        "--pi-home-include",
        "node_modules/package",
        "--pi-home-include",
        "skills/custom",
      ]),
    ).toMatchObject({
      sourceDir: ".",
      prompt: "Review it",
      piHomeSource: "/tmp/pi",
      piHomeIncludes: ["node_modules/package", "skills/custom"],
    });
  });
});
