import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewCliArgs } from "./review-cli-args.js";

describe("review CLI arguments", () => {
  it("keeps host filters for provider-only networking", () => {
    expect(
      parseReviewCliArgs([
        "--network",
        "provider-only",
        "--allow-host",
        "*.mirror.test",
        "--block-host=private.mirror.test",
      ]),
    ).toMatchObject({
      networkText: "provider-only",
      allowHosts: ["*.mirror.test"],
      blockHosts: ["private.mirror.test"],
      remaining: [],
    });
  });
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

  it("parses repeated Git review targets", () => {
    expect(
      parseReviewCliArgs(["--git", "working-tree", "--git", "commit:HEAD", "--git=staged"]),
    ).toMatchObject({
      gitTargets: ["working-tree", "commit:HEAD", "staged"],
    });
  });

  it("parses repeated Git symbolic-link root opt-ins as absolute paths", () => {
    expect(
      parseReviewCliArgs([
        "--allow-git-symlink-root",
        "/store/a",
        "--allow-git-symlink-root=relative/b",
        "--allow-android-repo-root",
        "/aosp/.repo",
      ]),
    ).toMatchObject({
      gitSymlinkRoots: [path.resolve("/store/a"), path.resolve("relative/b")],
      androidRepoRoots: [path.resolve("/aosp/.repo")],
      remaining: [],
    });
  });

  it("parses the opt-in for offline partial-clone inspection", () => {
    expect(parseReviewCliArgs(["--allow-partial-clone", "--git", "staged"])).toMatchObject({
      allowPartialClone: true,
      gitTargets: ["staged"],
      remaining: [],
    });
    expect(parseReviewCliArgs([]).allowPartialClone).toBe(false);
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
