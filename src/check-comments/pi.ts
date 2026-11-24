import { resolvePiCommand } from "../pi-command.js";
import {
  cleanupReviewRuntime,
  discoverPreparedExtensions,
  type PreparedReviewRuntime,
  prepareReviewRuntime,
  runPreparedPiCommand,
  runPreparedPiRpc,
} from "../pi-extension-discovery.js";
import { withNoForkSandbox } from "../pi-extension-runtime.js";
import { defaultPiAgentDir } from "../pi-home.js";
import { assertPiReady, reviewRuntimeEnvironment } from "../pi-readiness.js";
import {
  applyPiVersionToStartup,
  applyResolvedPiLaunch,
  optimizePiStartupCommand,
} from "../pi-startup.js";
import type { DiffComment } from "./extract.js";
import {
  COMMENT_CATEGORIES,
  type CommentCategory,
  type CommentScores,
  commentEvidence,
  commentEvidencePolicy,
  commentQuestions,
} from "./providers.js";

const PI_PROBE_TIMEOUT_MS = 10_000;
const PI_SCORING_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 4_096;
const QUALIFIED_PI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/~?[A-Za-z0-9][A-Za-z0-9._:@+-]*)+$/;
const SCORING_PROMPT = [
  commentEvidencePolicy,
  "Use taskScope as the contract, including explicit deferrals and guarantees made by callers. First determine which obligations and failures apply at this point in the code.",
  "Score each label independently. Agreed deferrals score zero as skipped asks and as in-scope TODOs. A TODO alone does not report a skipped requirement. If the contract guarantees an edge case cannot occur here, its dismissed-edge-case score is zero even when the comment gives a poor reason.",
  "Use a number between 0 and 1 for each label: confidence that all of its conditions hold. When a necessary condition is absent, assign 0. It is valid for all three scores to be 0.",
  ...COMMENT_CATEGORIES.map((label) => `${label}: ${commentQuestions[label]}`),
  'Return exactly this flat JSON object, replacing each zero with the probability of YES for that label. Omit explanations, nested objects and code fences: {"excuse_skipped_ask":0,"dismissed_edge_case":0,"in_scope_todo":0}',
].join("\n");

export function isQualifiedPiCommentModel(model: string): boolean {
  return model.length <= 256 && model === model.trim() && QUALIFIED_PI_MODEL.test(model);
}

function invalidReply(): Error {
  return new Error("[COMMENT_PI_RESPONSE_INVALID] Pi did not return the required JSON scores");
}

function parseScores(reply: string): CommentScores {
  if (Buffer.byteLength(reply) > MAX_REPLY_BYTES) throw invalidReply();
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    throw invalidReply();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== COMMENT_CATEGORIES.length
  )
    throw invalidReply();
  const fields = value as Record<string, unknown>;
  const result = {} as Record<CommentCategory, number>;
  for (const category of COMMENT_CATEGORIES) {
    const score = fields[category];
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)
      throw invalidReply();
    result[category] = score;
  }
  return result;
}

export function createPiCommentScorer(
  model: string,
  signal?: AbortSignal,
): (comment: DiffComment, scope: string) => Promise<CommentScores> {
  if (!isQualifiedPiCommentModel(model))
    throw new Error("[COMMENT_PI_CONFIG] Select a qualified Pi model with --model PROVIDER/MODEL");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "[COMMENT_PI_UNSUPPORTED] Pi comment scoring requires a native macOS or Linux sandbox",
    );

  return async (comment, scope) => {
    signal?.throwIfAborted();
    let runtime: PreparedReviewRuntime | undefined;
    let outcome: { scores: CommentScores } | { error: unknown };
    try {
      let command: ReturnType<typeof optimizePiStartupCommand>["command"];
      try {
        const environment = reviewRuntimeEnvironment(process.env);
        const launcher = await resolvePiCommand("pi", environment);
        const prepared = await prepareReviewRuntime(
          launcher,
          defaultPiAgentDir(),
          environment,
          "/tmp",
          undefined,
          false,
          "provider-only",
          signal,
          [],
          undefined,
          model,
          false,
          "classification",
        );
        runtime = prepared;
        const pi = withNoForkSandbox(prepared.extensions);
        const readiness = await assertPiReady({
          requestedModel: model,
          runner: async (args) =>
            args.includes("--list-models")
              ? await discoverPreparedExtensions(prepared, PI_PROBE_TIMEOUT_MS, signal)
              : await runPreparedPiCommand(prepared, [...pi, ...args], PI_PROBE_TIMEOUT_MS, signal),
          environment: { ...environment, ...prepared.home.environment },
          ...(signal === undefined ? {} : { signal }),
        });
        const resolved = readiness.resolvedModel;
        if (resolved === undefined || resolved.toLowerCase() !== model.toLowerCase())
          throw new Error("Unexpected resolved Pi model");
        prepared.providerNetwork?.bind(resolved);
        command = applyPiVersionToStartup(
          applyResolvedPiLaunch(
            optimizePiStartupCommand(
              [
                "pi",
                "--mode",
                "rpc",
                "--model",
                resolved,
                "--no-tools",
                "--no-context-files",
                "--thinking",
                "off",
                "--system-prompt",
                SCORING_PROMPT,
              ],
              { disableExtensions: true, disableSkills: true, noSession: true },
            ),
            pi,
          ),
          readiness.version,
        ).command;
      } catch {
        throw new Error(
          "[COMMENT_PI_READINESS_FAILED] Verify native sandbox support and configure the exact Pi model and provider endpoint",
        );
      }
      const prompt = commentEvidence(comment, scope);
      let reply: string;
      try {
        reply = await runPreparedPiRpc(runtime, command, prompt, PI_SCORING_TIMEOUT_MS, signal);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[REVIEW_TIMEOUT]"))
          throw new Error("[COMMENT_PI_TIMEOUT] Pi did not finish scoring within 30 seconds");
        throw new Error("[COMMENT_PI_TRANSPORT_FAILED] Pi failed during sandboxed scoring");
      }
      outcome = { scores: parseScores(reply) };
    } catch (error) {
      outcome = { error };
    }
    if (runtime !== undefined) {
      try {
        await cleanupReviewRuntime(runtime);
      } catch {
        throw new Error(
          "[COMMENT_PI_CLEANUP_FAILED] Pioneer could not remove the private Pi scoring runtime",
        );
      }
    }
    signal?.throwIfAborted();
    if ("error" in outcome) throw outcome.error;
    return outcome.scores;
  };
}
