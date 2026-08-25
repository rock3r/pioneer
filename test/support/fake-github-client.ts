import { DEEP_REVIEW_CHECK_NAME, type GitHubClient } from "../../src/github/deep-review/client.js";

export function createFakeGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getAuthenticatedActor: async () => ({ id: "99", login: "pioneer-bot" }),
    getRepository: async (owner, name) => ({ owner, name, id: "1" }),
    getPullRequest: async () => ({
      number: 1,
      title: "Title",
      body: "",
      htmlUrl: "https://github.com/acme/repo/pull/1",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    }),
    listPullCommits: async () => [{ sha: "b".repeat(40), title: "Commit", body: "" }],
    listPullFiles: async () => [
      {
        path: "src/main.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
      },
    ],
    listReviewComments: async () => [],
    listCheckRunsForRef: async () => [],
    createCheckRun: async (input) => ({
      id: "100",
      name: input.name,
      status: input.status,
      headSha: input.headSha,
    }),
    updateCheckRun: async (input) => ({
      id: input.checkRunId,
      name: DEEP_REVIEW_CHECK_NAME,
      status: input.status ?? "completed",
      headSha: "b".repeat(40),
      ...(input.conclusion ? { conclusion: input.conclusion } : {}),
    }),
    updateReviewComment: async (_owner, _repo, commentId, body) => ({
      id: commentId,
      authorId: "99",
      authorLogin: "pioneer-bot",
      body,
    }),
    createPullRequestReview: async () => ({ id: "200" }),
    ...overrides,
  };
}
