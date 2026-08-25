import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeGitHubClient } from "../../../test/support/fake-github-client.js";
import { registerManagedTempPaths } from "../../../test/support/temp-dir.js";
import {
  collectGitChangedFiles,
  collectPullRequestPacket,
  collectRepositoryRules,
  discoverRepositoryRulePaths,
  type GitRunner,
  gitArgsKey,
  isGitBinaryPatch,
  parseNameStatus,
  runGitCollect,
  SAFE_GIT_CONFIG,
} from "./collect.js";
import { buildMarkerPayload, formatMarkerComment } from "./marker.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function createScriptedGitRunner(
  responses: Record<string, { stdout?: string; exitCode?: number }>,
): GitRunner {
  return async (_executable, args, _cwd, _env) => {
    const key = gitArgsKey(args);
    const response = responses[key];
    if (!response) {
      return { stdout: "", stderr: `unexpected git args: ${key}`, exitCode: 1 };
    }
    return {
      stdout: response.stdout ?? "",
      stderr: "",
      exitCode: response.exitCode ?? 0,
    };
  };
}

describe("github deep-review collect", () => {
  const { createTempDir } = registerManagedTempPaths();
  it("uses discrete argv with shell disabled safe git config", async () => {
    let capturedArgs: readonly string[] = [];
    const gitRunner: GitRunner = async (_executable, args) => {
      capturedArgs = args;
      return { stdout: HEAD_SHA, stderr: "", exitCode: 0 };
    };
    await runGitCollect("/usr/bin/git", ["rev-parse", "HEAD"], "/tmp/repo", gitRunner);
    expect(capturedArgs.slice(0, 2)).toEqual(SAFE_GIT_CONFIG.slice(0, 2));
    expect(capturedArgs.at(-2)).toBe("rev-parse");
    expect(capturedArgs.at(-1)).toBe("HEAD");
  });

  it("collects a packet from fake GitHub and Git runners", async () => {
    const gitRunner = createScriptedGitRunner({
      "rev-parse\0HEAD": { stdout: `${HEAD_SHA}\n` },
      "rev-parse\0--show-object-format": { stdout: "sha1\n" },
      [`cat-file\0-e\0${BASE_SHA}^{commit}`]: { stdout: "" },
      [`cat-file\0-e\0${HEAD_SHA}^{commit}`]: { stdout: "" },
      [`merge-base\0${BASE_SHA}\0${HEAD_SHA}`]: { stdout: `${BASE_SHA}\n` },
      [`diff\0--name-status\0-z\0${BASE_SHA}...${HEAD_SHA}`]: {
        stdout: "M\0src/main.ts\0",
      },
      [`show\0${HEAD_SHA}:AGENTS.md`]: { stdout: "# Agent rules\n" },
      [`show\0${BASE_SHA}:AGENTS.md`]: { stdout: "# Agent rules\n" },
      [`show\0${HEAD_SHA}:CONTRIBUTING.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:CONTRIBUTING.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/ARCHITECTURE.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/ARCHITECTURE.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/CONVENTIONS.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/CONVENTIONS.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/SECURITY.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/SECURITY.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/TESTING.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/TESTING.md`]: { stdout: "", exitCode: 1 },
      [`diff\0${BASE_SHA}...${HEAD_SHA}\0--\0src/main.ts`]: {
        stdout: "@@ -1,1 +1,2 @@\n line\n+added\n",
      },
    });

    const marker = formatMarkerComment(
      buildMarkerPayload({
        repositoryOwner: "acme",
        repositoryName: "repo",
        pullRequestNumber: 1,
        findingId: `pdr_${"d".repeat(24)}`,
        headSha: HEAD_SHA,
        path: "src/main.ts",
        side: "RIGHT",
        line: 2,
        endLine: 2,
        category: "correctness",
      }),
    );

    const github = createFakeGitHubClient({
      getPullRequest: async () => ({
        number: 1,
        title: "Fix",
        body: "",
        htmlUrl: "https://github.com/acme/repo/pull/1",
        baseRef: "main",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      }),
      listReviewComments: async () => [
        {
          id: "10",
          authorId: "99",
          authorLogin: "pioneer-bot",
          body: `Prior finding\n\n${marker}`,
          path: "src/main.ts",
          line: 2,
          side: "RIGHT",
        },
        {
          id: "11",
          authorId: "500",
          authorLogin: "human",
          body: "Human review note",
        },
      ],
    });

    const tempDir = await createTempDir("pioneer-collect-");
    const outputPath = path.join(tempDir, "packet.json");

    const result = await collectPullRequestPacket({
      sourceDir: tempDir,
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      expectedHeadSha: HEAD_SHA,
      outputPath,
      github,
      gitExecutable: "/usr/bin/git",
      gitRunner,
    });

    expect(result.packet.pullRequest.headSha).toBe(HEAD_SHA);
    expect(result.packet.files[0]?.patch).toContain("+added");
    expect(result.packet.rules).toEqual([
      { path: "AGENTS.md", content: "# Agent rules\n", source: "head" },
    ]);
    expect(
      result.packet.previousFindings.some(
        (finding) => finding.marker?.findingId === `pdr_${"d".repeat(24)}`,
      ),
    ).toBe(true);
    expect(result.packet.previousFindings.some((finding) => finding.authorLogin === "human")).toBe(
      true,
    );

    const persisted = JSON.parse(await readFile(outputPath, "utf8")) as { packetDigest: string };
    expect(persisted.packetDigest).toBe(result.packet.packetDigest);
  });

  it("fails closed on stale event head SHA", async () => {
    const gitRunner = createScriptedGitRunner({
      "rev-parse\0HEAD": { stdout: `${HEAD_SHA}\n` },
    });
    const github = createFakeGitHubClient({
      getPullRequest: async () => ({
        number: 1,
        title: "Fix",
        body: "",
        htmlUrl: "https://github.com/acme/repo/pull/1",
        baseRef: "main",
        baseSha: BASE_SHA,
        headSha: "c".repeat(40),
      }),
    });
    const tempDir = await createTempDir("pioneer-collect-stale-");
    await expect(
      collectPullRequestPacket({
        sourceDir: tempDir,
        owner: "acme",
        repo: "repo",
        pullNumber: 1,
        expectedHeadSha: HEAD_SHA,
        outputPath: path.join(tempDir, "packet.json"),
        github,
        gitExecutable: "/usr/bin/git",
        gitRunner,
      }),
    ).rejects.toThrow(/DEEP_REVIEW_HEAD_CHANGED/);
  });

  it("fails closed on unrecognized git name-status codes", async () => {
    const gitRunner = createScriptedGitRunner({
      "rev-parse\0--show-object-format": { stdout: "sha1\n" },
      [`diff\0--name-status\0-z\0${BASE_SHA}...${HEAD_SHA}`]: {
        stdout: "X\0src/unknown.ts\0",
      },
    });
    await expect(
      collectGitChangedFiles("/tmp/repo", BASE_SHA, HEAD_SHA, "/usr/bin/git", gitRunner),
    ).rejects.toThrow(/unrecognized git name-status/);
  });

  it("does not force text diffs when collecting per-file patches", async () => {
    let perFileDiffArgs: readonly string[] = [];
    const gitRunner: GitRunner = async (_executable, args) => {
      const key = gitArgsKey(args);
      if (key === "rev-parse\0--show-object-format") {
        return { stdout: "sha1\n", stderr: "", exitCode: 0 };
      }
      if (key === `diff\0--name-status\0-z\0${BASE_SHA}...${HEAD_SHA}`) {
        return { stdout: "M\0src/main.ts\0", stderr: "", exitCode: 0 };
      }
      if (key === `diff\0${BASE_SHA}...${HEAD_SHA}\0--\0src/main.ts`) {
        perFileDiffArgs = args;
        return { stdout: "@@ -1,1 +1,2 @@\n line\n+added\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unexpected git args: ${key}`, exitCode: 1 };
    };

    await collectGitChangedFiles("/tmp/repo", BASE_SHA, HEAD_SHA, "/usr/bin/git", gitRunner);
    expect(perFileDiffArgs).not.toContain("--text");
  });

  it("marks binary git diffs without patches", async () => {
    const gitRunner = createScriptedGitRunner({
      "rev-parse\0--show-object-format": { stdout: "sha1\n" },
      [`diff\0--name-status\0-z\0${BASE_SHA}...${HEAD_SHA}`]: {
        stdout: "M\0assets/logo.png\0",
      },
      [`diff\0${BASE_SHA}...${HEAD_SHA}\0--\0assets/logo.png`]: {
        stdout: "Binary files a/assets/logo.png and b/assets/logo.png differ\n",
      },
    });
    const files = await collectGitChangedFiles(
      "/tmp/repo",
      BASE_SHA,
      HEAD_SHA,
      "/usr/bin/git",
      gitRunner,
    );
    expect(files[0]).toMatchObject({
      path: "assets/logo.png",
      contentKind: "binary",
    });
    expect(files[0]?.patch).toBeUndefined();
  });

  it("treats type-changed name-status entries as modified", async () => {
    const gitRunner = createScriptedGitRunner({
      "rev-parse\0--show-object-format": { stdout: "sha1\n" },
      [`diff\0--name-status\0-z\0${BASE_SHA}...${HEAD_SHA}`]: {
        stdout: "T\0src/link-target\0",
      },
      [`diff\0${BASE_SHA}...${HEAD_SHA}\0--\0src/link-target`]: {
        stdout: "@@ -1,1 +1,1 @@\n-old\n+new\n",
      },
    });
    const files = await collectGitChangedFiles(
      "/tmp/repo",
      BASE_SHA,
      HEAD_SHA,
      "/usr/bin/git",
      gitRunner,
    );
    expect(files[0]).toMatchObject({
      path: "src/link-target",
      status: "modified",
      contentKind: "text",
    });
  });

  it("parses NUL-delimited name-status paths with special characters", () => {
    const entries = parseNameStatus("M\0src/weird\tname.ts\0");
    expect(entries).toEqual([
      {
        path: "src/weird\tname.ts",
        status: "modified",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("detects git binary patches without matching arbitrary source text", () => {
    expect(isGitBinaryPatch("Binary files a/x and b/x differ\n")).toBe(true);
    expect(isGitBinaryPatch('@@ -1,3 +1,3 @@\n+const text = "Binary files differ";\n')).toBe(false);
  });

  it("discovers nested AGENTS.md paths from changed files", () => {
    expect([...discoverRepositoryRulePaths(["packages/api/src/handler.ts"])].sort()).toEqual(
      [
        "AGENTS.md",
        "CONTRIBUTING.md",
        "docs/ARCHITECTURE.md",
        "docs/CONVENTIONS.md",
        "docs/SECURITY.md",
        "docs/TESTING.md",
        "packages/AGENTS.md",
        "packages/api/AGENTS.md",
        "packages/api/src/AGENTS.md",
      ].sort(),
    );
  });

  it("collects base rules when head revision omits them", async () => {
    const gitRunner = createScriptedGitRunner({
      [`show\0${HEAD_SHA}:AGENTS.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:AGENTS.md`]: { stdout: "# Base rules\n" },
      [`show\0${HEAD_SHA}:CONTRIBUTING.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:CONTRIBUTING.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/ARCHITECTURE.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/ARCHITECTURE.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/CONVENTIONS.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/CONVENTIONS.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/SECURITY.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/SECURITY.md`]: { stdout: "", exitCode: 1 },
      [`show\0${HEAD_SHA}:docs/TESTING.md`]: { stdout: "", exitCode: 1 },
      [`show\0${BASE_SHA}:docs/TESTING.md`]: { stdout: "", exitCode: 1 },
    });
    const rules = await collectRepositoryRules(
      "/tmp/repo",
      BASE_SHA,
      HEAD_SHA,
      "/usr/bin/git",
      gitRunner,
    );
    expect(rules).toEqual([{ path: "AGENTS.md", content: "# Base rules\n", source: "base" }]);
  });
});
