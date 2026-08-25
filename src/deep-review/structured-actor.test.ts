import { describe, expect, it } from "vitest";
import { optimizePiStartupCommand } from "../pi-startup.js";
import { MIN_RPC_OUTPUT_BYTES, validateRpcOutputBytes } from "../review/rpc-limits.js";
import { DEFAULT_MAX_MODEL_OUTPUT_BYTES } from "./config.js";
import { deepReviewActorTools } from "./inspection-extension.js";
import { buildStructuredActorPiCommand } from "./structured-actor.js";

describe("deep-review actor RPC limits", () => {
  it("keeps structured model output cap separate from Pi RPC transport cap", () => {
    expect(DEFAULT_MAX_MODEL_OUTPUT_BYTES).toBeLessThan(MIN_RPC_OUTPUT_BYTES);
    expect(() => validateRpcOutputBytes(DEFAULT_MAX_MODEL_OUTPUT_BYTES)).toThrow(
      /RPC output byte limit/,
    );
  });
});

describe("buildStructuredActorPiCommand", () => {
  it("does not combine --no-session with an embedded --session-dir", () => {
    const base = buildStructuredActorPiCommand("pi", {
      model: "provider/model",
      tools: deepReviewActorTools(false),
      extensionPath: "/extensions/inspection.ts",
      piHomeDir: "/scratch/pi-home/agent",
      sessionDir: "/scratch/session",
      actorEnvironment: {},
    });

    const optimized = optimizePiStartupCommand(base, {
      disableExtensions: true,
      disableSkills: true,
      noSession: false,
      sessionDir: "/scratch/session",
      tools: deepReviewActorTools(false),
    });

    expect(optimized.command.filter((value) => value === "--no-session")).toHaveLength(0);
    expect(optimized.command).toEqual(
      expect.arrayContaining(["--session-dir", "/scratch/session"]),
    );
  });
});
