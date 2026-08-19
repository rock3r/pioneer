import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_CASE_FILE_NAME,
  EVAL_FIXTURES_DIR_NAME,
  formatEvalActorContract,
  readPreparedEvalCase,
  type StagedEvalFixture,
  stagePromptFixtureReferences,
} from "./actor-contract.js";

function fixture(sourcePath: string, stagedPath: string): StagedEvalFixture {
  return { sourcePath, stagedPath };
}

describe("stagePromptFixtureReferences", () => {
  it("rewrites a bare fixture basename to its staged actor-visible path", () => {
    expect(
      stagePromptFixtureReferences("Review this panel. File: fixture_42.kt", [
        fixture("evals/files/fixture_42.kt", "fixtures/fixture_42.kt"),
      ]),
    ).toBe("Review this panel. File: fixtures/fixture_42.kt");
  });

  it("rewrites the source-relative spelling used by evals.json", () => {
    expect(
      stagePromptFixtureReferences("Review evals/files/fixture_42.kt now", [
        fixture("evals/files/fixture_42.kt", "fixtures/fixture_42.kt"),
      ]),
    ).toBe("Review fixtures/fixture_42.kt now");
  });

  it("rewrites Windows-separated and dot-relative spellings", () => {
    expect(
      stagePromptFixtureReferences("Open evals\\files\\fixture_42.kt and ./fixture_42.kt", [
        fixture("evals/files/fixture_42.kt", "fixtures/fixture_42.kt"),
      ]),
    ).toBe("Open fixtures/fixture_42.kt and fixtures/fixture_42.kt");
  });

  it("keeps prompts that already use the staged path unchanged", () => {
    expect(
      stagePromptFixtureReferences("Review fixtures/fixture_42.kt", [
        fixture("evals/files/fixture_42.kt", "fixtures/fixture_42.kt"),
      ]),
    ).toBe("Review fixtures/fixture_42.kt");
  });

  it("rewrites references followed by punctuation", () => {
    expect(
      stagePromptFixtureReferences('Review "fixture_42.kt", then stop.', [
        fixture("evals/files/fixture_42.kt", "fixtures/fixture_42.kt"),
      ]),
    ).toBe('Review "fixtures/fixture_42.kt", then stop.');
  });

  it("does not rewrite a longer unrelated name that merely contains a fixture name", () => {
    expect(
      stagePromptFixtureReferences("Ignore other_fixture_42.kt and legacy/fixture_42.kt2", [
        fixture("evals/files/fixture_42.kt", "fixtures/fixture_42.kt"),
      ]),
    ).toBe("Ignore other_fixture_42.kt and legacy/fixture_42.kt2");
  });

  it("keeps nested staged directories in the rewritten path", () => {
    expect(
      stagePromptFixtureReferences("Compare panel/before.kt with panel/after.kt", [
        fixture("evals/files/panel/before.kt", "fixtures/panel/before.kt"),
        fixture("evals/files/panel/after.kt", "fixtures/panel/after.kt"),
      ]),
    ).toBe("Compare fixtures/panel/before.kt with fixtures/panel/after.kt");
  });

  it("leaves an ambiguous shared basename alone but rewrites its distinct relative paths", () => {
    expect(
      stagePromptFixtureReferences("Compare a/panel.kt, b/panel.kt, and panel.kt", [
        fixture("evals/files/a/panel.kt", "fixtures/a/panel.kt"),
        fixture("evals/files/b/panel.kt", "fixtures/b/panel.kt"),
      ]),
    ).toBe("Compare fixtures/a/panel.kt, fixtures/b/panel.kt, and panel.kt");
  });

  it("returns the prompt unchanged when no fixture is staged", () => {
    expect(stagePromptFixtureReferences("Review the fixture.", [])).toBe("Review the fixture.");
  });
});

describe("readPreparedEvalCase", () => {
  it("reports the staged fixtures of a prepared run directory", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "pioneer-case-"));
    await writeFile(
      path.join(runDir, EVAL_CASE_FILE_NAME),
      JSON.stringify({
        id: 42,
        prompt: "Review fixtures/fixture_42.kt",
        files: ["fixtures/fixture_42.kt"],
      }),
    );

    await expect(readPreparedEvalCase(runDir)).resolves.toEqual({
      id: 42,
      stagedFiles: ["fixtures/fixture_42.kt"],
    });
  });

  it("returns undefined for an unprepared run directory", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "pioneer-case-"));

    await expect(readPreparedEvalCase(runDir)).resolves.toBeUndefined();
  });

  it("ignores malformed, escaping, absolute, and oversized entries written by an actor", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "pioneer-case-"));
    await writeFile(
      path.join(runDir, EVAL_CASE_FILE_NAME),
      JSON.stringify({
        id: "not-a-number",
        files: [
          "fixtures/ok.kt",
          "../escape.kt",
          "/etc/passwd",
          "fixtures/bad\u0007name.kt",
          42,
          `fixtures/${"x".repeat(5_000)}.kt`,
        ],
      }),
    );

    await expect(readPreparedEvalCase(runDir)).resolves.toEqual({
      stagedFiles: ["fixtures/ok.kt"],
    });
  });

  it("returns undefined for an oversized or unparsable case file", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "pioneer-case-"));
    await writeFile(path.join(runDir, EVAL_CASE_FILE_NAME), "x".repeat(300 * 1024));

    await expect(readPreparedEvalCase(runDir)).resolves.toBeUndefined();
  });
});

describe("formatEvalActorContract", () => {
  it("documents the actor working directory, fixtures directory, and prepared prompt", () => {
    const lines = formatEvalActorContract("/runs/eval-42/with-skill", {
      id: 42,
      stagedFiles: ["fixtures/fixture_42.kt"],
    });

    expect(lines[0]).toContain("[PIONEER_EVAL_ACTOR_CONTRACT]");
    expect(lines[0]).toContain("/runs/eval-42/with-skill");
    expect(lines[0]).toContain(`${EVAL_FIXTURES_DIR_NAME}/`);
    expect(lines[0]).toContain(EVAL_CASE_FILE_NAME);
    expect(lines).toContain("[PIONEER_EVAL_FIXTURES] fixtures/fixture_42.kt");
  });

  it("bounds the listed fixtures and reports how many were omitted", () => {
    const stagedFiles = Array.from({ length: 30 }, (_, index) => `fixtures/fixture_${index}.kt`);

    const lines = formatEvalActorContract("/runs/eval-1/baseline", { stagedFiles });

    expect(lines).toHaveLength(22);
    expect(lines.at(-1)).toBe("[PIONEER_EVAL_FIXTURES] 10 more staged files listed in case.json");
  });

  it("strips terminal control sequences from actor-written staged names", () => {
    const lines = formatEvalActorContract("/runs/eval-1/baseline", {
      stagedFiles: ["fixtures/\u202Etxt.harmless.kt"],
    });

    expect(lines[1]).toBe("[PIONEER_EVAL_FIXTURES] fixtures/txt.harmless.kt");
  });

  it("documents the contract even when no fixtures are staged", () => {
    const lines = formatEvalActorContract("/runs/eval-1/baseline", { stagedFiles: [] });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[PIONEER_EVAL_ACTOR_CONTRACT]");
  });
});
