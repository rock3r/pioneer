import { sanitizeDiagnostic } from "../../diagnostics.js";

export const DEEP_REVIEW_CHECK_NAME = "Pioneer deep review";

export interface GitHubActor {
  readonly id: string;
  readonly login: string;
}

export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  readonly id?: string;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface GitHubCommit {
  readonly sha: string;
  readonly title: string;
  readonly body: string;
}

export type GitHubPullFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface GitHubPullFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: GitHubPullFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

export type GitHubReviewSide = "LEFT" | "RIGHT";

export interface GitHubReviewComment {
  readonly id: string;
  readonly authorId: string;
  readonly authorLogin: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly side?: GitHubReviewSide;
  readonly startLine?: number;
  readonly startSide?: GitHubReviewSide;
  readonly commitId?: string;
  readonly inReplyToId?: string;
}

export type GitHubCheckStatus = "queued" | "in_progress" | "completed";

export type GitHubCheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export interface GitHubCheckRun {
  readonly id: string;
  readonly name: string;
  readonly status: GitHubCheckStatus;
  readonly conclusion?: GitHubCheckConclusion;
  readonly headSha: string;
  readonly detailsUrl?: string;
}

export interface CreateCheckRunInput {
  readonly owner: string;
  readonly repo: string;
  readonly name: string;
  readonly headSha: string;
  readonly status: GitHubCheckStatus;
  readonly conclusion?: GitHubCheckConclusion;
  readonly output?: GitHubCheckOutput;
  readonly externalId?: string;
}

export interface UpdateCheckRunInput {
  readonly owner: string;
  readonly repo: string;
  readonly checkRunId: string;
  readonly status?: GitHubCheckStatus;
  readonly conclusion?: GitHubCheckConclusion;
  readonly output?: GitHubCheckOutput;
}

export interface GitHubCheckOutput {
  readonly title: string;
  readonly summary: string;
}

export interface InlineReviewCommentInput {
  readonly path: string;
  readonly body: string;
  readonly side: GitHubReviewSide;
  readonly line: number;
  readonly startLine?: number;
  readonly startSide?: GitHubReviewSide;
}

export interface CreatePullRequestReviewInput {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly commitId: string;
  readonly event: "COMMENT";
  readonly comments: readonly InlineReviewCommentInput[];
}

export interface GitHubClient {
  getAuthenticatedActor(): Promise<GitHubActor>;
  getRepository(owner: string, repo: string): Promise<GitHubRepository>;
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequest>;
  listPullCommits(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<readonly GitHubCommit[]>;
  listPullFiles(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<readonly GitHubPullFile[]>;
  listReviewComments(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<readonly GitHubReviewComment[]>;
  listCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
    checkName?: string,
  ): Promise<readonly GitHubCheckRun[]>;
  createCheckRun(input: CreateCheckRunInput): Promise<GitHubCheckRun>;
  updateCheckRun(input: UpdateCheckRunInput): Promise<GitHubCheckRun>;
  updateReviewComment(
    owner: string,
    repo: string,
    commentId: string,
    body: string,
  ): Promise<GitHubReviewComment>;
  createPullRequestReview(input: CreatePullRequestReviewInput): Promise<{ readonly id: string }>;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export function parseGitHubLinkNext(linkHeader: string | null): string | undefined {
  if (linkHeader === null || linkHeader.length === 0) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

const MAX_GITHUB_LIST_PAGES = 100;

export function sanitizeGitHubErrorMessage(message: string, token?: string): string {
  const secrets = token ? [token] : [];
  return sanitizeDiagnostic(message, secrets);
}

export interface FetchGitHubClientOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly apiBaseUrl?: string;
}

export function createFetchGitHubClient(options: FetchGitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBaseUrl ?? "https://api.github.com";
  const token = options.token;

  async function requestPage<T>(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<{ readonly data: T; readonly linkHeader: string | null }> {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "pioneer-github-deep-review",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const pathForError = url.startsWith(apiBase) ? url.slice(apiBase.length) : url;
    if (!response.ok) {
      throw new GitHubApiError(
        sanitizeGitHubErrorMessage(
          `[DEEP_REVIEW_GITHUB_FAILED] GitHub API ${method} ${pathForError} returned ${response.status}: ${text.slice(0, 512)}`,
          token,
        ),
        response.status,
      );
    }
    if (text.length === 0) {
      return { data: undefined as T, linkHeader: response.headers.get("link") };
    }
    return { data: JSON.parse(text) as T, linkHeader: response.headers.get("link") };
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { data } = await requestPage<T>(`${apiBase}${path}`, method, body);
    return data;
  }

  async function collectPaged<T>(
    initialPath: string,
    mapPage: (body: unknown) => readonly T[],
  ): Promise<readonly T[]> {
    const collected: T[] = [];
    let nextUrl: string | undefined = `${apiBase}${initialPath}`;
    let pages = 0;
    while (nextUrl !== undefined) {
      pages += 1;
      if (pages > MAX_GITHUB_LIST_PAGES) {
        throw new Error("[DEEP_REVIEW_GITHUB_FAILED] GitHub list pagination exceeded safety limit");
      }
      const { data, linkHeader } = await requestPage<unknown>(nextUrl, "GET");
      collected.push(...mapPage(data));
      nextUrl = parseGitHubLinkNext(linkHeader);
    }
    return collected;
  }

  return {
    async getAuthenticatedActor() {
      const user = await request<{ id: number; login: string }>("GET", "/user");
      return { id: String(user.id), login: user.login };
    },

    async getRepository(owner, repo) {
      const data = await request<{ id?: number; name: string; owner: { login: string } }>(
        "GET",
        `/repos/${owner}/${repo}`,
      );
      return {
        owner: data.owner.login,
        name: data.name,
        ...(data.id !== undefined ? { id: String(data.id) } : {}),
      };
    },

    async getPullRequest(owner, repo, pullNumber) {
      const data = await request<{
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        base: { ref: string; sha: string };
        head: { sha: string };
      }>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}`);
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        htmlUrl: data.html_url,
        baseRef: data.base.ref,
        baseSha: data.base.sha,
        headSha: data.head.sha,
      };
    },

    async listPullCommits(owner, repo, pullNumber) {
      const data = await collectPaged(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=100`,
        (body) => body as readonly { sha: string; commit: { message: string } }[],
      );
      return data.map((entry) => {
        const [title, ...rest] = entry.commit.message.split("\n");
        return {
          sha: entry.sha,
          title: title ?? "",
          body: rest.join("\n"),
        };
      });
    },

    async listPullFiles(owner, repo, pullNumber) {
      const data = await collectPaged(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`,
        (body) =>
          body as readonly {
            filename: string;
            previous_filename?: string;
            status: string;
            additions: number;
            deletions: number;
            patch?: string;
          }[],
      );
      return data.map((file) => ({
        path: file.filename,
        ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
        status: normalizePullFileStatus(file.status),
        additions: file.additions,
        deletions: file.deletions,
        ...(file.patch !== undefined ? { patch: file.patch } : {}),
      }));
    },

    async listReviewComments(owner, repo, pullNumber) {
      const data = await collectPaged(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100`,
        (body) =>
          body as readonly {
            id: number;
            user: { id: number; login: string } | null;
            body: string;
            path?: string;
            line?: number | null;
            side?: GitHubReviewSide | null;
            start_line?: number | null;
            start_side?: GitHubReviewSide | null;
            commit_id?: string;
            in_reply_to_id?: number;
          }[],
      );
      return data.map((comment) => mapReviewComment(comment));
    },

    async listCheckRunsForRef(owner, repo, ref, checkName) {
      const encodedRef = encodeURIComponent(ref);
      const runs = await collectPaged(
        `/repos/${owner}/${repo}/commits/${encodedRef}/check-runs?per_page=100`,
        (body) => {
          const page = body as {
            check_runs: readonly {
              id: number;
              name: string;
              status: GitHubCheckStatus;
              conclusion: GitHubCheckConclusion | null;
              head_sha: string;
              details_url?: string;
            }[];
          };
          return page.check_runs.map((run) => ({
            id: String(run.id),
            name: run.name,
            status: run.status,
            headSha: run.head_sha,
            ...(run.conclusion ? { conclusion: run.conclusion } : {}),
            ...(run.details_url ? { detailsUrl: run.details_url } : {}),
          }));
        },
      );
      return checkName ? runs.filter((run) => run.name === checkName) : runs;
    },

    async createCheckRun(input) {
      const data = await request<{
        id: number;
        name: string;
        status: GitHubCheckStatus;
        conclusion: GitHubCheckConclusion | null;
        head_sha: string;
        details_url?: string;
      }>("POST", `/repos/${input.owner}/${input.repo}/check-runs`, {
        name: input.name,
        head_sha: input.headSha,
        status: input.status,
        ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        ...(input.output ? { output: input.output } : {}),
        ...(input.externalId ? { external_id: input.externalId } : {}),
      });
      return {
        id: String(data.id),
        name: data.name,
        status: data.status,
        headSha: data.head_sha,
        ...(data.conclusion ? { conclusion: data.conclusion } : {}),
        ...(data.details_url ? { detailsUrl: data.details_url } : {}),
      };
    },

    async updateCheckRun(input) {
      const data = await request<{
        id: number;
        name: string;
        status: GitHubCheckStatus;
        conclusion: GitHubCheckConclusion | null;
        head_sha: string;
        details_url?: string;
      }>("PATCH", `/repos/${input.owner}/${input.repo}/check-runs/${input.checkRunId}`, {
        ...(input.status ? { status: input.status } : {}),
        ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        ...(input.output ? { output: input.output } : {}),
      });
      return {
        id: String(data.id),
        name: data.name,
        status: data.status,
        headSha: data.head_sha,
        ...(data.conclusion ? { conclusion: data.conclusion } : {}),
        ...(data.details_url ? { detailsUrl: data.details_url } : {}),
      };
    },

    async updateReviewComment(owner, repo, commentId, body) {
      const data = await request<{
        id: number;
        user: { id: number; login: string } | null;
        body: string;
        path?: string;
        line?: number | null;
        side?: GitHubReviewSide | null;
        start_line?: number | null;
        start_side?: GitHubReviewSide | null;
        commit_id?: string;
        in_reply_to_id?: number;
      }>("PATCH", `/repos/${owner}/${repo}/pulls/comments/${commentId}`, { body });
      return mapReviewComment(data);
    },

    async createPullRequestReview(input) {
      const data = await request<{ id: number }>(
        "POST",
        `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`,
        {
          commit_id: input.commitId,
          event: input.event,
          comments: input.comments.map((comment) => ({
            path: comment.path,
            body: comment.body,
            side: comment.side,
            line: comment.line,
            ...(comment.startLine !== undefined ? { start_line: comment.startLine } : {}),
            ...(comment.startSide !== undefined ? { start_side: comment.startSide } : {}),
          })),
        },
      );
      return { id: String(data.id) };
    },
  };
}

function normalizePullFileStatus(status: string): GitHubPullFileStatus {
  const normalized = status === "removed" ? "deleted" : status;
  if (
    normalized === "added" ||
    normalized === "modified" ||
    normalized === "deleted" ||
    normalized === "renamed" ||
    normalized === "copied"
  ) {
    return normalized;
  }
  throw new Error(`[DEEP_REVIEW_GITHUB_FAILED] unsupported pull file status: ${status}`);
}

function mapReviewComment(comment: {
  id: number;
  user: { id: number; login: string } | null;
  body: string;
  path?: string;
  line?: number | null;
  side?: GitHubReviewSide | null;
  start_line?: number | null;
  start_side?: GitHubReviewSide | null;
  commit_id?: string;
  in_reply_to_id?: number;
}): GitHubReviewComment {
  return {
    id: String(comment.id),
    authorId: comment.user ? String(comment.user.id) : "0",
    authorLogin: comment.user?.login ?? "ghost",
    body: comment.body,
    ...(comment.path ? { path: comment.path } : {}),
    ...(comment.line != null ? { line: comment.line } : {}),
    ...(comment.side ? { side: comment.side } : {}),
    ...(comment.start_line != null ? { startLine: comment.start_line } : {}),
    ...(comment.start_side ? { startSide: comment.start_side } : {}),
    ...(comment.commit_id ? { commitId: comment.commit_id } : {}),
    ...(comment.in_reply_to_id !== undefined
      ? { inReplyToId: String(comment.in_reply_to_id) }
      : {}),
  };
}
