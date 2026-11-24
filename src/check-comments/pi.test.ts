import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePiCommand } from "../pi-command.js";
import {
  cleanupReviewRuntime,
  type PreparedReviewRuntime,
  prepareReviewRuntime,
  runPreparedPiRpc,
} from "../pi-extension-discovery.js";
import { assertPiReady } from "../pi-readiness.js";
import { createPiCommentScorer } from "./pi.js";

vi.mock("../pi-command.js", () => ({ resolvePiCommand: vi.fn() }));
vi.mock("../pi-extension-discovery.js", () => ({
  cleanupReviewRuntime: vi.fn(),
  discoverPreparedExtensions: vi.fn(),
  prepareReviewRuntime: vi.fn(),
  runPreparedPiCommand: vi.fn(),
  runPreparedPiRpc: vi.fn(),
}));
vi.mock("../pi-readiness.js", () => ({
  assertPiReady: vi.fn(),
  reviewRuntimeEnvironment: () => ({ PATH: "/fixture" }),
}));

const bind = vi.fn();
const runtime = {
  extensions: { command: ["/fixture/pi"] },
  home: { environment: { PI_CODING_AGENT_DIR: "/fixture/isolated-agent" } },
  providerNetwork: { bind },
} as unknown as PreparedReviewRuntime;
const scores = { excuse_skipped_ask: 0, dismissed_edge_case: 0.1, in_scope_todo: 0.9 };
const comment = {
  path: "private-path.ts",
  text: "// TODO do <validation>",
  context: "validate();",
  startLine: 2,
  endLine: 2,
};

describe.skipIf(process.platform === "win32")("tool-free Pi comment classification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolvePiCommand).mockResolvedValue(["/fixture/pi"]);
    vi.mocked(prepareReviewRuntime).mockResolvedValue(runtime);
    vi.mocked(assertPiReady).mockResolvedValue({
      ready: true,
      modelCount: 1,
      version: "1.6.0",
      resolvedModel: "openai-codex/fixture-model",
      errors: [],
    });
    vi.mocked(runPreparedPiRpc).mockResolvedValue(JSON.stringify(scores));
  });

  it("binds the exact model with private provider-only preparation and disables tools and context", async () => {
    const result = await createPiCommentScorer("openai-codex/fixture-model")(
      comment,
      "Implement validation",
    );
    expect(result).toEqual(scores);
    expect(vi.mocked(prepareReviewRuntime).mock.calls[0]?.slice(5)).toEqual([
      false,
      "provider-only",
      undefined,
      [],
      undefined,
      "openai-codex/fixture-model",
      false,
      "classification",
    ]);
    expect(bind).toHaveBeenCalledWith("openai-codex/fixture-model");
    const [prepared, command, prompt, timeout] = vi.mocked(runPreparedPiRpc).mock.calls[0] ?? [];
    expect(prepared).toBe(runtime);
    expect(command).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--model",
        "openai-codex/fixture-model",
        "--no-tools",
        "--no-mcp",
        "--no-extensions",
        "--no-skills",
        "--no-session",
        "--no-prompt-templates",
        "--no-themes",
      ]),
    );
    expect(command?.join(" ")).not.toContain("Implement validation");
    expect(command).toEqual(expect.arrayContaining(["--no-context-files", "--system-prompt"]));
    expect(JSON.parse(prompt ?? "{}")).toMatchObject({
      taskScope: "Implement validation",
      comment: comment.text,
    });
    expect(prompt).toContain("TODO do \\u003cvalidation\\u003e");
    expect(prompt).not.toContain(comment.path);
    expect(timeout).toBe(30_000);
    expect(cleanupReviewRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it.each([
    "```json\n{}\n```",
    '{"secret":"actor-controlled-content"}',
    JSON.stringify({ ...scores, in_scope_todo: 1.1 }),
    JSON.stringify({ ...scores, in_scope_todo: "0.9" }),
    JSON.stringify({ ...scores, extra: true }),
    `${JSON.stringify(scores)}${" ".repeat(4_096)}`,
  ])("rejects an invalid JSON score without echoing the reply", async (reply) => {
    vi.mocked(runPreparedPiRpc).mockResolvedValue(reply);
    const result = createPiCommentScorer("openai-codex/fixture-model")(comment, "Validate");
    await expect(result).rejects.toThrow(/^\[COMMENT_PI_RESPONSE_INVALID\]/);
    await expect(result).rejects.not.toThrow("actor-controlled-content");
    expect(cleanupReviewRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it("fails closed if readiness selects a different model", async () => {
    vi.mocked(assertPiReady).mockResolvedValue({
      ready: true,
      modelCount: 1,
      version: "1.6.0",
      resolvedModel: "other/model",
      errors: [],
    });
    await expect(
      createPiCommentScorer("openai-codex/fixture-model")(comment, "Validate"),
    ).rejects.toThrow(/^\[COMMENT_PI_READINESS_FAILED\]/);
    expect(runPreparedPiRpc).not.toHaveBeenCalled();
    expect(cleanupReviewRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it("reports a fixed timeout diagnostic without transport text", async () => {
    vi.mocked(runPreparedPiRpc).mockRejectedValue(
      new Error("[REVIEW_TIMEOUT] actor-controlled-content"),
    );
    const result = createPiCommentScorer("openai-codex/fixture-model")(comment, "Validate");
    await expect(result).rejects.toThrow(/^\[COMMENT_PI_TIMEOUT\]/);
    await expect(result).rejects.not.toThrow("actor-controlled-content");
    expect(cleanupReviewRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it("preserves cancellation from readiness after cleaning up the prepared runtime", async () => {
    const controller = new AbortController();
    const interruption = new Error("[COMMENT_PI_INTERRUPTED] Pi scoring stopped on SIGINT.");
    vi.mocked(assertPiReady).mockImplementation(async (options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(interruption);
      throw interruption;
    });
    const score = createPiCommentScorer("openai-codex/fixture-model", controller.signal);
    await expect(score(comment, "Validate")).rejects.toBe(interruption);
    expect(runPreparedPiRpc).not.toHaveBeenCalled();
    expect(cleanupReviewRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it("requires a qualified model before performing readiness", () => {
    expect(() => createPiCommentScorer("fixture-model")).toThrow(/^\[COMMENT_PI_CONFIG\]/);
    expect(resolvePiCommand).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== "win32")(
  "rejects Pi comment classification without a native sandbox",
  () => {
    expect(() => createPiCommentScorer("openai-codex/fixture-model")).toThrow(
      /^\[COMMENT_PI_UNSUPPORTED\]/,
    );
    expect(resolvePiCommand).not.toHaveBeenCalled();
  },
);
