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

  it("accepts option-like Pi-home includes through attached values", () => {
    expect(parseReviewCliArgs(["--pi-home-include=--shared"]).piHomeIncludes).toEqual(["--shared"]);
  });

  it("parses bounded RPC output and explicit no-resume options", () => {
    expect(
      parseReviewCliArgs(["--max-rpc-output-mb", "64", "--no-resume", "--resume", "token"]),
    ).toMatchObject({
      maxRpcOutputMbText: "64",
      noResume: true,
      resumeToken: "token",
      networkSpecified: false,
    });
  });
});
