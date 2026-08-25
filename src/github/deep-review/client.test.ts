import { describe, expect, it } from "vitest";
import {
  createFetchGitHubClient,
  DEEP_REVIEW_CHECK_NAME,
  GitHubApiError,
  parseGitHubLinkNext,
  sanitizeGitHubErrorMessage,
} from "./client.js";

describe("github deep-review client", () => {
  it("redacts tokens from GitHub error messages", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const sanitized = sanitizeGitHubErrorMessage(`request failed with ${token}`, token);
    expect(sanitized).not.toContain(token);
    expect(sanitized).toContain("[REDACTED]");
  });

  it("exposes bounded GitHub client operations through fetch", async () => {
    const token = "ghp_testtoken1234567890123456789012";
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const path = url.replace("https://api.github.com", "");
      calls.push({
        method,
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (path === "/user") {
        return new Response(JSON.stringify({ id: 99, login: "pioneer-bot" }), { status: 200 });
      }
      if (path === "/repos/acme/repo") {
        return new Response(JSON.stringify({ id: 1, name: "repo", owner: { login: "acme" } }), {
          status: 200,
        });
      }
      if (path === "/repos/acme/repo/pulls/7") {
        return new Response(
          JSON.stringify({
            number: 7,
            title: "Title",
            body: "Body",
            html_url: "https://github.com/acme/repo/pull/7",
            base: { ref: "main", sha: "a".repeat(40) },
            head: { sha: "b".repeat(40) },
          }),
          { status: 200 },
        );
      }
      if (path.startsWith("/repos/acme/repo/pulls/7/commits")) {
        return new Response(
          JSON.stringify([{ sha: "b".repeat(40), commit: { message: "Commit\n\nBody" } }]),
          { status: 200 },
        );
      }
      if (path.startsWith("/repos/acme/repo/pulls/7/files")) {
        return new Response(
          JSON.stringify([
            {
              filename: "src/main.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ patch",
            },
          ]),
          { status: 200 },
        );
      }
      if (path.startsWith("/repos/acme/repo/pulls/7/comments")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (path.startsWith("/repos/acme/repo/commits/")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (path.endsWith("/check-runs") && method === "POST") {
        return new Response(
          JSON.stringify({
            id: 42,
            name: DEEP_REVIEW_CHECK_NAME,
            status: "in_progress",
            conclusion: null,
            head_sha: "b".repeat(40),
          }),
          { status: 201 },
        );
      }
      return new Response("missing", { status: 404 });
    };

    const client = createFetchGitHubClient({ token, fetchImpl });
    const actor = await client.getAuthenticatedActor();
    expect(actor).toEqual({ id: "99", login: "pioneer-bot" });
    const pull = await client.getPullRequest("acme", "repo", 7);
    expect(pull.headSha).toBe("b".repeat(40));
    expect(calls.some((call) => call.path === "/user")).toBe(true);
  });

  it("maps GitHub removed file status to deleted", async () => {
    const client = createFetchGitHubClient({
      token: "ghp_testtoken1234567890123456789012",
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = url.replace("https://api.github.com", "");
        if (path.startsWith("/repos/acme/repo/pulls/7/files")) {
          return new Response(
            JSON.stringify([
              {
                filename: "src/removed.ts",
                status: "removed",
                additions: 0,
                deletions: 3,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("missing", { status: 404 });
      },
    });

    const files = await client.listPullFiles("acme", "repo", 7);
    expect(files).toEqual([
      {
        path: "src/removed.ts",
        status: "deleted",
        additions: 0,
        deletions: 3,
      },
    ]);
  });

  it("throws sanitized GitHubApiError on failure", async () => {
    const token = `ghp_${"b".repeat(36)}`;
    const client = createFetchGitHubClient({
      token,
      fetchImpl: async () => new Response(`bad ${token}`, { status: 500 }),
    });
    await expect(client.getAuthenticatedActor()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(String(error)).not.toContain(token);
      return true;
    });
  });

  it("follows Link pagination for review comments", async () => {
    let page = 0;
    const client = createFetchGitHubClient({
      token: `ghp_${"d".repeat(36)}`,
      fetchImpl: async (input) => {
        page += 1;
        const url = String(input);
        if (page === 1) {
          expect(url).toContain("/pulls/1/comments?per_page=100");
          return new Response(
            JSON.stringify([{ id: 1, user: { id: 99, login: "pioneer-bot" }, body: "first page" }]),
            {
              status: 200,
              headers: {
                link: '<https://api.github.com/repos/acme/repo/pulls/1/comments?page=2&per_page=100>; rel="next"',
              },
            },
          );
        }
        expect(url).toContain("page=2");
        return new Response(
          JSON.stringify([{ id: 2, user: { id: 99, login: "pioneer-bot" }, body: "second page" }]),
          { status: 200 },
        );
      },
    });

    const comments = await client.listReviewComments("acme", "repo", 1);
    expect(comments).toHaveLength(2);
    expect(comments.map((comment) => comment.id)).toEqual(["1", "2"]);
    expect(page).toBe(2);
  });

  it("parses GitHub Link next URLs", () => {
    expect(
      parseGitHubLinkNext(
        '<https://api.github.com/resource?page=2>; rel="next", <https://api.github.com/resource?page=1>; rel="first"',
      ),
    ).toBe("https://api.github.com/resource?page=2");
    expect(parseGitHubLinkNext(null)).toBeUndefined();
  });

  it("supports creating COMMENT reviews with inline comments", async () => {
    let capturedBody: unknown;
    const client = createFetchGitHubClient({
      token: `ghp_${"c".repeat(36)}`,
      fetchImpl: async (_input, init) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(JSON.stringify({ id: 5 }), { status: 201 });
      },
    });
    await client.createPullRequestReview({
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      commitId: "d".repeat(40),
      event: "COMMENT",
      comments: [
        {
          path: "src/main.ts",
          body: "Finding body",
          side: "RIGHT",
          line: 10,
        },
      ],
    });
    expect(capturedBody).toEqual({
      commit_id: "d".repeat(40),
      event: "COMMENT",
      comments: [{ path: "src/main.ts", body: "Finding body", side: "RIGHT", line: 10 }],
    });
  });
});
