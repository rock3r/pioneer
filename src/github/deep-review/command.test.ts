import { describe, expect, it, vi } from "vitest";
import { createFakeGitHubClient } from "../../../test/support/fake-github-client.js";
import { type GitRunner, gitArgsKey } from "./collect.js";
import { runGitHubDeepReviewCli } from "./command.js";

const HEAD_SHA = "b".repeat(40);

describe("github deep-review command", () => {
  it("prints usage for --help", async () => {
    const stdout: string[] = [];
    await runGitHubDeepReviewCli(["--help"], "pioneer github deep-review", {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    expect(stdout.join("")).toContain("collect --source");
  });

  it("starts an in-progress check run", async () => {
    vi.stubEnv("GITHUB_TOKEN", `ghp_${"a".repeat(36)}`);
    const stdout: string[] = [];
    await runGitHubDeepReviewCli(
      ["start", "--owner", "acme", "--repo", "repo", "--head-sha", HEAD_SHA],
      "pioneer github deep-review",
      {
        stdout: (text) => stdout.push(text),
        stderr: () => {},
      },
      {
        createClient: () => createFakeGitHubClient(),
      },
    );
    expect(JSON.parse(stdout.join(""))).toMatchObject({ checkRunId: "100" });
    vi.unstubAllEnvs();
  });

  it("collects a packet through the collect subcommand", async () => {
    vi.stubEnv("GITHUB_TOKEN", `ghp_${"b".repeat(36)}`);
    const stdout: string[] = [];
    const gitRunner: GitRunner = async (_executable, args) => {
      const key = gitArgsKey(args);
      if (key === "rev-parse\0HEAD") return { stdout: `${HEAD_SHA}\n`, stderr: "", exitCode: 0 };
      if (key.startsWith("cat-file")) return { stdout: "", stderr: "", exitCode: 0 };
      if (key.startsWith("merge-base"))
        return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
      if (key.includes("--name-status"))
        return { stdout: "M\tsrc/main.ts\n", stderr: "", exitCode: 0 };
      if (key.includes("src/main.ts")) {
        return { stdout: "@@ -1,1 +1,2 @@\n line\n+added\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };

    const tempOutput = `/tmp/pioneer-packet-${Date.now()}.json`;
    await runGitHubDeepReviewCli(
      [
        "collect",
        "--source",
        "/tmp/repo",
        "--owner",
        "acme",
        "--repo",
        "repo",
        "--pr",
        "1",
        "--head-sha",
        HEAD_SHA,
        "--output",
        tempOutput,
      ],
      "pioneer github deep-review",
      {
        stdout: (text) => stdout.push(text),
        stderr: () => {},
      },
      {
        resolveGit: async () => "/usr/bin/git",
        gitRunner,
        createClient: () =>
          createFakeGitHubClient({
            getPullRequest: async () => ({
              number: 1,
              title: "Fix",
              body: "",
              htmlUrl: "https://github.com/acme/repo/pull/1",
              baseRef: "main",
              baseSha: "a".repeat(40),
              headSha: HEAD_SHA,
            }),
          }),
      },
    );
    expect(JSON.parse(stdout.join(""))).toMatchObject({ outputPath: tempOutput });
    vi.unstubAllEnvs();
  });

  it("redacts tokens from publish stderr", async () => {
    const token = `ghp_${"c".repeat(36)}`;
    vi.stubEnv("GITHUB_TOKEN", token);
    const stderr: string[] = [];
    await expect(
      runGitHubDeepReviewCli(
        [
          "publish",
          "--owner",
          "acme",
          "--repo",
          "repo",
          "--pr",
          "1",
          "--result",
          "/missing/result.json",
          "--packet",
          "/missing/packet.json",
          "--check-run-id",
          "100",
        ],
        "pioneer github deep-review",
        {
          stdout: () => {},
          stderr: (text) => stderr.push(text),
        },
        {
          createClient: () => createFakeGitHubClient(),
        },
      ),
    ).rejects.toThrow();
    expect(stderr.join("")).not.toContain(token);
    vi.unstubAllEnvs();
  });
});
