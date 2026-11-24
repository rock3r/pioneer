import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { CliUsageError, sanitizeDiagnostic } from "../diagnostics.js";
import { collectGitDiffs, parseGitTargets } from "../review/git-inspect.js";
import { MAX_COMMENT_DIFF_BYTES } from "./diff.js";
import { type DiffComment, extractDiffComments } from "./extract.js";
import { createPiCommentScorer, isQualifiedPiCommentModel } from "./pi.js";
import {
  COMMENT_CATEGORIES,
  type CommentCategory,
  type CommentProviderOptions,
  type CommentScores,
  commentProviderKeyEnv,
  createCommentScorer,
  type FetchDecision,
} from "./providers.js";

const USAGE = `Usage:
  pioneer check-comments (--source DIR --git TARGET... | --diff-file FILE|-)
    (--scope TEXT | --scope-file FILE)
    [--provider typesafe|cloudflare|gemini|custom|pi] [--model ID]
    [--endpoint HTTPS_URL] [--api-key-env VAR] [--threshold FLOAT]
    [--max-comments N] [--concurrency N] [--allow-partial-clone] [--json] [--fail-on-findings]

Defaults: TypeSafe Jev, threshold 0.8, up to 50 comments, four concurrent requests.
Git targets: staged, working-tree, commit:REF, range:FROM...TO, range:FROM..TO.
Credentials: TYPESAFE_API_KEY, CLOUDFLARE_API_TOKEN with CLOUDFLARE_ACCOUNT_ID, or GEMINI_API_KEY.
Custom System One gateways require --endpoint, --model and --api-key-env.
Pi requires a qualified --model PROVIDER/MODEL and runs one comment at a time.`;

const MAX_SCOPE_BYTES = 16 * 1024;
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_MAX_COMMENTS = 50;
const DEFAULT_CONCURRENCY = 4;
const OPTIONS = {
  source: { type: "string" },
  git: { type: "string", multiple: true },
  "diff-file": { type: "string" },
  scope: { type: "string" },
  "scope-file": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  endpoint: { type: "string" },
  "api-key-env": { type: "string" },
  threshold: { type: "string" },
  "max-comments": { type: "string" },
  concurrency: { type: "string" },
  "allow-partial-clone": { type: "boolean" },
  json: { type: "boolean" },
  "fail-on-findings": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type TextStream = AsyncIterable<Uint8Array | string>;
type CommentScorer = (comment: DiffComment, scope: string) => Promise<CommentScores>;
type ScoringBackend =
  | { readonly kind: "pi"; readonly model: string }
  | { readonly kind: "http"; readonly options: CommentProviderOptions };
interface CliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: FetchDecision;
  readonly stdin?: TextStream;
  readonly stdout?: (text: string) => void;
}

interface CommentLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface Finding extends CommentLocation {
  readonly category: CommentCategory;
  readonly probability: number;
}

interface Failure extends Partial<CommentLocation> {
  readonly message: string;
}

interface Result {
  readonly complete: boolean;
  readonly threshold: number;
  readonly extracted: number;
  readonly scored: number;
  readonly omitted: number;
  readonly findings: readonly Finding[];
  readonly failures: readonly Failure[];
}

type Outcome = { readonly findings: readonly Finding[] } | { readonly failure: Failure };

function usage(message: string): never {
  throw new CliUsageError(`${message}\n\n${USAGE}`);
}

function normalizeGitArgs(raw: readonly string[]): string[] {
  const args: string[] = [];
  let inGit = false;
  for (const value of raw) {
    if (inGit && !value.startsWith("-") && args.at(-1) !== "--git") args.push("--git");
    args.push(value);
    if (value.startsWith("-")) inGit = value === "--git" || value.startsWith("--git=");
  }
  return args;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
  flag: string,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    usage(`Set ${flag} to an integer from 1 to ${maximum}.`);
  }
  return number;
}

function thresholdValue(value: string | undefined): number {
  if (value === undefined) return DEFAULT_THRESHOLD;
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < 0 || number > 1) {
    usage("Set --threshold to a number from 0 to 1.");
  }
  return number;
}

function parseBackend(
  provider: string,
  model: string | undefined,
  endpoint: string | undefined,
  apiKeyEnv: string | undefined,
): ScoringBackend {
  if (provider === "pi") {
    if (endpoint !== undefined || apiKeyEnv !== undefined) {
      usage("Pi scoring does not accept --endpoint or --api-key-env.");
    }
    if (model === undefined || !isQualifiedPiCommentModel(model)) {
      usage("Pi scoring requires a qualified --model PROVIDER/MODEL.");
    }
    return { kind: "pi", model };
  }
  if (
    provider !== "typesafe" &&
    provider !== "cloudflare" &&
    provider !== "gemini" &&
    provider !== "custom"
  ) {
    usage("Set --provider to typesafe, cloudflare, gemini, custom or pi.");
  }
  return {
    kind: "http",
    options: {
      provider,
      ...(model === undefined ? {} : { model }),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    },
  };
}

function parseOptions(rawArgs: readonly string[]) {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; tokens: true }>>;
  try {
    parsed = parseArgs({ args: normalizeGitArgs(rawArgs), options: OPTIONS, tokens: true });
  } catch {
    usage("Invalid check-comments arguments. Check option names and values.");
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || token.name === "git") continue;
    if (seen.has(token.name)) usage("Supply each option only once, except --git.");
    seen.add(token.name);
  }
  const values = parsed.values;
  if (values.help) return undefined;
  const { source, scope, git = [], provider = "typesafe" } = values;
  const diffFile = values["diff-file"];
  const scopeFile = values["scope-file"];
  if (
    diffFile === "" ||
    source === "" ||
    (diffFile !== undefined
      ? source !== undefined || git.length > 0 || values["allow-partial-clone"]
      : source === undefined || git.length === 0)
  ) {
    usage("Choose either --source DIR --git TARGET... or --diff-file FILE|-.");
  }
  if (
    (scope === undefined) === (scopeFile === undefined) ||
    scope?.trim() === "" ||
    scopeFile === ""
  ) {
    usage("Choose either --scope TEXT or --scope-file FILE with a nonempty task scope.");
  }
  const backend = parseBackend(provider, values.model, values.endpoint, values["api-key-env"]);
  if (backend.kind === "pi" && values.concurrency !== undefined && values.concurrency !== "1") {
    usage("Pi scoring requires --concurrency 1.");
  }
  return {
    diffFile,
    source,
    git,
    allowPartialClone: values["allow-partial-clone"] === true,
    scope,
    scopeFile,
    backend,
    threshold: thresholdValue(values.threshold),
    maxComments: boundedInteger(
      values["max-comments"],
      DEFAULT_MAX_COMMENTS,
      1_000,
      "--max-comments",
    ),
    concurrency:
      backend.kind === "pi"
        ? 1
        : boundedInteger(values.concurrency, DEFAULT_CONCURRENCY, 16, "--concurrency"),
    json: values.json === true,
    failOnFindings: values["fail-on-findings"] === true,
  };
}

type CommandOptions = NonNullable<ReturnType<typeof parseOptions>>;

function inputLimit(subject: string, limit: number): Error {
  return new Error(`[COMMENT_INPUT_LIMIT] ${subject} exceeds ${limit} UTF-8 bytes.`);
}

async function readStream(stream: TextStream, subject: string, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += bytes.byteLength;
    if (length > limit) throw inputLimit(subject, limit);
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } catch {
    throw new Error(`[COMMENT_INPUT_ENCODING] ${subject} must contain valid UTF-8 text.`);
  }
}

async function readRegularFile(file: string, subject: string, limit: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`[COMMENT_INPUT_INVALID] ${subject} must be a regular file.`);
    if (stats.size > limit) throw inputLimit(subject, limit);
    return await readStream(handle.createReadStream({ autoClose: false }), subject, limit);
  } finally {
    await handle.close();
  }
}

async function readScope(options: CommandOptions): Promise<string> {
  const scope =
    options.scope ??
    (await readRegularFile(options.scopeFile ?? "", "Task scope", MAX_SCOPE_BYTES));
  if (Buffer.byteLength(scope) > MAX_SCOPE_BYTES) throw inputLimit("Task scope", MAX_SCOPE_BYTES);
  if (!scope.trim()) throw new Error("[COMMENT_INPUT_INVALID] Supply a nonempty task scope.");
  return scope;
}

async function readComments(options: CommandOptions, stdin: TextStream): Promise<DiffComment[]> {
  if (options.diffFile !== undefined) {
    const diff =
      options.diffFile === "-"
        ? await readStream(stdin, "Unified diff", MAX_COMMENT_DIFF_BYTES)
        : await readRegularFile(options.diffFile, "Unified diff", MAX_COMMENT_DIFF_BYTES);
    return extractDiffComments(diff);
  }
  const patches = await collectGitDiffs(
    path.resolve(options.source ?? "."),
    parseGitTargets(options.git),
    {
      allowPartialClone: options.allowPartialClone,
    },
  );
  if (patches.some((patch) => patch.truncated)) {
    throw new Error("[COMMENT_INPUT_LIMIT] Git diff is incomplete. Choose a smaller change set.");
  }
  const unique = new Map<string, DiffComment>();
  for (const patch of patches) {
    for (const comment of extractDiffComments(patch.diff)) {
      const key = JSON.stringify([comment.path, comment.startLine, comment.endLine, comment.text]);
      if (!unique.has(key)) unique.set(key, comment);
    }
  }
  return [...unique.values()];
}

function userError(error: unknown, fallback: string, secrets: readonly string[]): string {
  if (error instanceof Error && /^\[(?:COMMENT_|REVIEW_GIT_|REVIEW_SOURCE_)/.test(error.message)) {
    return sanitizeDiagnostic(error.message, secrets);
  }
  return fallback;
}

function locationOf(comment: DiffComment, secret: string | undefined): CommentLocation {
  return {
    path: secret ? comment.path.replaceAll(secret, "[REDACTED]") : comment.path,
    startLine: comment.startLine,
    endLine: comment.endLine,
  };
}

async function scoreComments(
  comments: readonly DiffComment[],
  options: CommandOptions,
  scope: string,
  score: CommentScorer,
  secret: string | undefined,
): Promise<Result> {
  const count = Math.min(comments.length, options.maxComments);
  const outcomes: Outcome[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < count) {
      const index = next;
      next += 1;
      const comment = comments[index];
      if (comment === undefined) break;
      const location = locationOf(comment, secret);
      try {
        if (comment.oversized) throw new Error("[COMMENT_INPUT_LIMIT] Comment exceeds 8 KiB.");
        const probabilities: CommentScores = await score(comment, scope);
        outcomes[index] = {
          findings: COMMENT_CATEGORIES.filter(
            (category) => probabilities[category] >= options.threshold,
          ).map((category) => ({ ...location, category, probability: probabilities[category] })),
        };
      } catch (error) {
        outcomes[index] = {
          failure: {
            ...location,
            message: userError(
              error,
              "Decision scoring failed.",
              secret === undefined ? [] : [secret],
            ),
          },
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, count) }, worker));
  const findings = outcomes.flatMap((outcome) => ("findings" in outcome ? outcome.findings : []));
  const failures = outcomes.flatMap((outcome) => ("failure" in outcome ? [outcome.failure] : []));
  const omitted = comments.length - count;
  const scored = count - failures.length;
  return {
    complete: failures.length === 0 && omitted === 0,
    threshold: options.threshold,
    extracted: comments.length,
    scored,
    omitted,
    findings,
    failures,
  };
}

function formatText(result: Result): string {
  const lines = [
    "Checked " +
      result.scored +
      " of " +
      result.extracted +
      " comments. " +
      result.findings.length +
      (result.findings.length === 1 ? " finding." : " findings."),
  ];
  for (const finding of result.findings) {
    lines.push(`${formatLocation(finding)} ${finding.category} (${finding.probability})`);
  }
  for (const { message, ...location } of result.failures) {
    lines.push((location.path === undefined ? "" : `${formatLocation(location)} `) + message);
  }
  if (result.omitted > 0) lines.push(`${result.omitted} comments omitted by --max-comments.`);
  return `${lines.join("\n")}\n`;
}

function formatLocation(value: Partial<CommentLocation>): string {
  const path = JSON.stringify(value.path ?? "").replace(
    /\p{Cf}/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${path}:${value.startLine}${value.endLine === value.startLine ? "" : `-${value.endLine}`}`;
}

export async function runCheckCommentsCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const options = parseOptions(args);
  if (options === undefined) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  const environment = dependencies.environment ?? process.env;
  const { backend } = options;
  const keyEnv = backend.kind === "http" ? commentProviderKeyEnv(backend.options) : undefined;
  const key =
    keyEnv !== undefined && Object.hasOwn(environment, keyEnv) ? environment[keyEnv] : undefined;
  let result: Result;
  try {
    const score =
      backend.kind === "pi"
        ? createPiCommentScorer(backend.model)
        : createCommentScorer(
            backend.options,
            environment,
            dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch },
          );
    const scope = await readScope(options);
    const comments = await readComments(options, dependencies.stdin ?? process.stdin);
    result = await scoreComments(comments, options, scope, score, key);
  } catch (error) {
    result = {
      complete: false,
      threshold: options.threshold,
      extracted: 0,
      scored: 0,
      omitted: 0,
      findings: [],
      failures: [
        {
          message: userError(
            error,
            "Could not read comment-check inputs. Verify the repository, scope file or diff file is accessible.",
            key === undefined ? [] : [key],
          ),
        },
      ],
    };
  }
  stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatText(result));
  if (!result.complete) return 3;
  return options.failOnFindings && result.findings.length > 0 ? 2 : 0;
}
