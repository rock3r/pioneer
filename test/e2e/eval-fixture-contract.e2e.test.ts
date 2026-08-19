import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvalWorkspace,
  createSkillFixture,
  type EvalWorkspace,
  nativeEvalSandboxAvailable,
  type PreparedCaseFile,
  parsePreparedBattery,
  runPioneer,
} from "./support/harness.js";
import { writeScriptedPi } from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();
const workspaces: EvalWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.remove()));
});

async function workspace(name: string): Promise<EvalWorkspace> {
  const created = await createEvalWorkspace(name);
  workspaces.push(created);
  return created;
}

async function readPreparedCase(runDir: string): Promise<PreparedCaseFile> {
  return JSON.parse(await readFile(path.join(runDir, "case.json"), "utf8")) as PreparedCaseFile;
}

describe("pioneer eval prepare stages fixtures where prompts name them", () => {
  it("rewrites prompts, records the source prompt, and returns the actor contract", async () => {
    const created = await workspace("prepare-contract");
    const skill = await createSkillFixture(created, {
      files: [{ relativePath: "fixture_42.kt", contents: "class Fixture42 { fun go() = 42 }\n" }],
      cases: [
        {
          id: 42,
          prompt: "Review this suggested-response panel. File: fixture_42.kt",
          files: ["evals/files/fixture_42.kt"],
          expectedOutput: "answer-key-must-not-be-staged",
          expectations: ["expectation-must-not-be-staged"],
        },
      ],
    });

    const prepared = await runPioneer(created, [
      "eval",
      "prepare",
      "--skill",
      skill.skillDir,
      "--evals",
      skill.evalsPath,
      "--output",
      path.join(created.root, "battery"),
    ]);

    expect(prepared.exitCode).toBe(0);
    const battery = parsePreparedBattery(prepared.stdout);
    expect(battery.actorContract).toEqual({
      caseFile: "case.json",
      fixturesDir: "fixtures",
      promptField: "prompt",
      description: expect.stringContaining("fixtures/NAME"),
    });
    expect(prepared.stderr).toContain("[PIONEER_EVAL_ACTOR_CONTRACT]");

    for (const arm of ["baseline", "with-skill"] as const) {
      const runDir = battery.runDir(42, arm);
      const preparedCase = await readPreparedCase(runDir);
      expect(preparedCase.prompt).toBe(
        "Review this suggested-response panel. File: fixtures/fixture_42.kt",
      );
      expect(preparedCase.source_prompt).toBe(
        "Review this suggested-response panel. File: fixture_42.kt",
      );
      expect(preparedCase.fixtures_dir).toBe("fixtures");
      expect(preparedCase.files).toEqual(["fixtures/fixture_42.kt"]);
      // Every path the prepared prompt names resolves from the actor working directory.
      const named = preparedCase.prompt.split(" ").at(-1) ?? "";
      expect(await readFile(path.join(runDir, named), "utf8")).toBe(
        "class Fixture42 { fun go() = 42 }\n",
      );
      const staged = await readFile(path.join(runDir, "case.json"), "utf8");
      expect(staged).not.toContain("answer-key-must-not-be-staged");
      expect(staged).not.toContain("expectation-must-not-be-staged");
    }
  });

  it("keeps nested fixture directories and rewrites every reference in one prompt", async () => {
    const created = await workspace("prepare-nested");
    const skill = await createSkillFixture(created, {
      files: [
        { relativePath: "panel/before.kt", contents: "before\n" },
        { relativePath: "panel/after.kt", contents: "after\n" },
      ],
      cases: [
        {
          id: 7,
          prompt: "Compare panel/before.kt with panel/after.kt and report drift.",
          files: ["evals/files/panel/before.kt", "evals/files/panel/after.kt"],
        },
      ],
    });

    const prepared = await runPioneer(created, [
      "eval",
      "prepare",
      "--skill",
      skill.skillDir,
      "--evals",
      skill.evalsPath,
      "--output",
      path.join(created.root, "battery"),
    ]);

    expect(prepared.exitCode).toBe(0);
    const runDir = parsePreparedBattery(prepared.stdout).runDir(7, "with-skill");
    const preparedCase = await readPreparedCase(runDir);
    expect(preparedCase.prompt).toBe(
      "Compare fixtures/panel/before.kt with fixtures/panel/after.kt and report drift.",
    );
    expect(preparedCase.files).toEqual(["fixtures/panel/before.kt", "fixtures/panel/after.kt"]);
    expect(await readFile(path.join(runDir, "fixtures", "panel", "after.kt"), "utf8")).toBe(
      "after\n",
    );
  });
});

describe.skipIf(!sandboxReady)("pioneer eval run resolves staged fixtures for the actor", () => {
  it("reviews the fixture the prepared prompt names without any filesystem search", async () => {
    const created = await workspace("run-fixture");
    await writeScriptedPi(created, { actor: { kind: "review-referenced-files" } });
    const skill = await createSkillFixture(created, {
      files: [{ relativePath: "fixture_42.kt", contents: "class Fixture42 { fun go() = 42 }\n" }],
      cases: [
        {
          id: 42,
          prompt: "Review this suggested-response panel. File: fixture_42.kt",
          files: ["evals/files/fixture_42.kt"],
        },
      ],
    });
    const prepared = await runPioneer(created, [
      "eval",
      "prepare",
      "--skill",
      skill.skillDir,
      "--evals",
      skill.evalsPath,
      "--output",
      path.join(created.root, "battery"),
    ]);
    expect(prepared.exitCode).toBe(0);
    const battery = parsePreparedBattery(prepared.stdout);
    const runDir = battery.runDir(42, "with-skill");
    const preparedCase = await readPreparedCase(runDir);

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("fixture-run"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--skill",
      path.join(runDir, "skills", "example-skill"),
      "--print",
      preparedCase.prompt,
    ]);

    expect(run.stderr).not.toContain("can't locate");
    expect(run.exitCode).toBe(0);
    const review = JSON.parse(run.stdout) as {
      model: string;
      reviewed: Array<{ file: string; firstLine: string }>;
      skill: string;
    };
    expect(review.model).toBe("scripted/fake-model");
    expect(review.reviewed).toEqual([
      { file: "fixtures/fixture_42.kt", firstLine: "class Fixture42 { fun go() = 42 }" },
    ]);
    expect(review.skill).toContain("example-skill");
    expect(run.stderr).toContain("[PIONEER_EVAL_ACTOR_CONTRACT]");
    expect(run.stderr).toContain("[PIONEER_EVAL_FIXTURES] fixtures/fixture_42.kt");
  });

  it("lets an actor list its run directory and fixtures without spawning a search", async () => {
    const created = await workspace("run-listing");
    await writeScriptedPi(created, { actor: { kind: "list-run-directory" } });
    const skill = await createSkillFixture(created, {
      files: [{ relativePath: "fixture_43.kt", contents: "class Fixture43\n" }],
      cases: [
        {
          id: 43,
          prompt: "Review fixture_43.kt",
          files: ["evals/files/fixture_43.kt"],
        },
      ],
    });
    const prepared = await runPioneer(created, [
      "eval",
      "prepare",
      "--skill",
      skill.skillDir,
      "--evals",
      skill.evalsPath,
      "--output",
      path.join(created.root, "battery"),
    ]);
    expect(prepared.exitCode).toBe(0);
    const runDir = parsePreparedBattery(prepared.stdout).runDir(43, "baseline");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("listing-run"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--print",
      "List the staged fixtures.",
    ]);

    expect(run.exitCode).toBe(0);
    const listing = JSON.parse(run.stdout) as {
      entries: string[];
      fixtures: string[];
      preparedCase: PreparedCaseFile;
    };
    expect(listing.entries).toContain("fixtures");
    expect(listing.entries).toContain("case.json");
    expect(listing.fixtures).toEqual(["fixture_43.kt"]);
    expect(listing.preparedCase.prompt).toBe("Review fixtures/fixture_43.kt");
    expect(listing.preparedCase.files).toEqual(["fixtures/fixture_43.kt"]);
  });
});
