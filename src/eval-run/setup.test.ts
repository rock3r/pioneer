import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { prepareEvalBattery } from "./setup.js";

const { createTempDir } = registerManagedTempPaths();

async function createSkillFixture(): Promise<{ root: string; skillDir: string }> {
  const root = await createTempDir("pioneer-battery-");
  const skillDir = path.join(root, "example-skill");
  await mkdir(path.join(skillDir, "evals", "files"), { recursive: true });
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: example-skill\ndescription: Example\n---\n\n# Example\n",
  );
  await writeFile(path.join(skillDir, "references", "guide.md"), "safe reference");
  await writeFile(path.join(skillDir, "skill-source.json"), '{"secret":"provenance"}');
  await writeFile(path.join(skillDir, "evals", "files", "sample.txt"), "prompt-safe fixture");
  await writeFile(
    path.join(skillDir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "example-skill",
      evals: [
        {
          id: 1,
          prompt: "Review the fixture.",
          expected_output: "Secret answer key",
          files: ["evals/files/sample.txt"],
          expectations: ["Never visible to actors"],
        },
      ],
    }),
  );
  return { root, skillDir };
}

describe("prepareEvalBattery", () => {
  it("creates isolated prompt-only arms and omits all answer-key material", async () => {
    const fixture = await createSkillFixture();
    const outputRoot = path.join(fixture.root, "battery");
    const result = await prepareEvalBattery({
      skillDir: fixture.skillDir,
      evalsPath: path.join(fixture.skillDir, "evals", "evals.json"),
      outputRoot,
    });

    const baseline = path.join(result.actorRunsDir, "eval-1", "baseline");
    const withSkill = path.join(result.actorRunsDir, "eval-1", "with-skill");
    const baselineCase = await readFile(path.join(baseline, "case.json"), "utf8");
    const skillCase = await readFile(path.join(withSkill, "case.json"), "utf8");
    expect(baselineCase).toBe(skillCase);
    expect(baselineCase).toContain("Review the fixture.");
    expect(baselineCase).not.toContain("Secret answer key");
    expect(baselineCase).not.toContain("Never visible");
    await expect(
      readFile(path.join(baseline, "skills", "example-skill", "SKILL.md")),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(withSkill, "skills", "example-skill", "SKILL.md"), "utf8"),
    ).toContain("# Example");
    await expect(
      readFile(path.join(withSkill, "skills", "example-skill", "evals", "evals.json")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(withSkill, "skills", "example-skill", "skill-source.json")),
    ).rejects.toThrow();
    expect(await readFile(path.join(baseline, "fixtures", "sample.txt"), "utf8")).toBe(
      "prompt-safe fixture",
    );
    expect(await readFile(path.join(withSkill, "fixtures", "sample.txt"), "utf8")).toBe(
      "prompt-safe fixture",
    );
  });

  it("stages fixtures at the path the prepared prompt names", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [
          {
            id: 7,
            prompt: "Review this panel. File: sample.txt",
            files: ["evals/files/sample.txt"],
          },
        ],
      }),
    );

    const result = await prepareEvalBattery({
      skillDir: fixture.skillDir,
      evalsPath,
      outputRoot: path.join(fixture.root, "battery"),
    });

    const runDir = path.join(result.actorRunsDir, "eval-7", "with-skill");
    const preparedCase = JSON.parse(await readFile(path.join(runDir, "case.json"), "utf8")) as {
      prompt: string;
      source_prompt: string;
      fixtures_dir: string;
      files: string[];
    };
    expect(preparedCase.prompt).toBe("Review this panel. File: fixtures/sample.txt");
    expect(preparedCase.source_prompt).toBe("Review this panel. File: sample.txt");
    expect(preparedCase.fixtures_dir).toBe("fixtures");
    expect(preparedCase.files).toEqual(["fixtures/sample.txt"]);
    expect(await readFile(path.join(runDir, preparedCase.files[0] ?? ""), "utf8")).toBe(
      "prompt-safe fixture",
    );
    expect(result.actorContract).toEqual({
      caseFile: "case.json",
      fixturesDir: "fixtures",
      promptField: "prompt",
      description:
        "Run each actor with its run directory as the working directory. Prepared prompts reference staged fixtures as fixtures/NAME relative to that directory, and case.json lists every staged file.",
    });
  });

  it("leaves a prompt that names no staged fixture unchanged", async () => {
    const fixture = await createSkillFixture();

    const result = await prepareEvalBattery({
      skillDir: fixture.skillDir,
      evalsPath: path.join(fixture.skillDir, "evals", "evals.json"),
      outputRoot: path.join(fixture.root, "battery"),
    });

    const baselineCase = JSON.parse(
      await readFile(path.join(result.actorRunsDir, "eval-1", "baseline", "case.json"), "utf8"),
    ) as { prompt: string; source_prompt: string };
    expect(baselineCase.prompt).toBe("Review the fixture.");
    expect(baselineCase.source_prompt).toBe("Review the fixture.");
  });

  it("refuses source skills containing symlinks", async () => {
    const fixture = await createSkillFixture();
    await symlink(
      path.join(fixture.root, "outside"),
      path.join(fixture.skillDir, "references", "escape"),
    );

    await expect(
      prepareEvalBattery({
        skillDir: fixture.skillDir,
        evalsPath: path.join(fixture.skillDir, "evals", "evals.json"),
        outputRoot: path.join(fixture.root, "battery"),
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a skill name that escapes the prepared actor skill directory", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    const escapedSkillDir = path.join(fixture.root, "escaped-skill");
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "../../../../../escaped-skill",
        evals: [{ id: 1, prompt: "Review the fixture.", files: [] }],
      }),
    );

    await expect(
      prepareEvalBattery({
        skillDir: fixture.skillDir,
        evalsPath,
        outputRoot: path.join(fixture.root, "battery"),
      }),
    ).rejects.toThrow(/skill_name/i);
    await expect(readFile(path.join(escapedSkillDir, "SKILL.md"))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects an output path whose canonical parent places it inside the source skill",
    async () => {
      const fixture = await createSkillFixture();
      const outputAlias = path.join(fixture.root, "output-link");
      await symlink(fixture.skillDir, outputAlias);

      await expect(
        prepareEvalBattery({
          skillDir: fixture.skillDir,
          evalsPath: path.join(fixture.skillDir, "evals", "evals.json"),
          outputRoot: path.join(outputAlias, "battery"),
        }),
      ).rejects.toThrow(/outside the source skill/i);
      await expect(
        readFile(path.join(fixture.skillDir, "battery", "controller", "manifest.json")),
      ).rejects.toThrow();
    },
  );

  it("rejects a dot-prefixed output path inside the source skill", async () => {
    const fixture = await createSkillFixture();
    await expect(
      prepareEvalBattery({
        skillDir: fixture.skillDir,
        evalsPath: path.join(fixture.skillDir, "evals", "evals.json"),
        outputRoot: path.join(fixture.skillDir, "..battery"),
      }),
    ).rejects.toThrow(/outside the source skill/i);
  });

  it("rejects a fixture basename that leaks the expected finding before creating output", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    await writeFile(
      path.join(fixture.skillDir, "evals", "files", "MOTION-stale.md"),
      "duration: 300",
    );
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [{ id: 1, prompt: "Review CONFIG.md", files: ["evals/files/MOTION-stale.md"] }],
      }),
    );
    const outputRoot = path.join(fixture.root, "battery");

    await expect(
      prepareEvalBattery({ skillDir: fixture.skillDir, evalsPath, outputRoot }),
    ).rejects.toThrow(/\[EVAL_FIXTURE_LEAK\].*stale/);
    await expect(readFile(path.join(outputRoot, "controller", "manifest.json"))).rejects.toThrow();
  });

  it("rejects a leaking intermediate directory and allows BadgeCase.kt", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    await mkdir(path.join(fixture.skillDir, "evals", "files", "rough-tier"), { recursive: true });
    await writeFile(
      path.join(fixture.skillDir, "evals", "files", "rough-tier", "Screen.kt"),
      "class Screen",
    );
    await writeFile(
      path.join(fixture.skillDir, "evals", "files", "BadgeCase.kt"),
      "class BadgeCase",
    );
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [
          {
            id: 1,
            prompt: "Review Screen.kt",
            files: ["evals/files/rough-tier/Screen.kt"],
          },
        ],
      }),
    );

    await expect(
      prepareEvalBattery({
        skillDir: fixture.skillDir,
        evalsPath,
        outputRoot: path.join(fixture.root, "leaking-battery"),
      }),
    ).rejects.toThrow(/\[EVAL_FIXTURE_LEAK\].*rough/);

    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [{ id: 2, prompt: "Review BadgeCase.kt", files: ["evals/files/BadgeCase.kt"] }],
      }),
    );
    const allowed = await prepareEvalBattery({
      skillDir: fixture.skillDir,
      evalsPath,
      outputRoot: path.join(fixture.root, "badge-battery"),
    });
    expect(
      await readFile(
        path.join(allowed.actorRunsDir, "eval-2", "baseline", "fixtures", "BadgeCase.kt"),
        "utf8",
      ),
    ).toBe("class BadgeCase");
  });

  it("prepares a fixture whose contents mention DEBUG: without a BUG: marker", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    await writeFile(
      path.join(fixture.skillDir, "evals", "files", "parser.ts"),
      "DEBUG: request failed\n",
    );
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [{ id: 1, prompt: "Review parser.ts", files: ["evals/files/parser.ts"] }],
      }),
    );

    const result = await prepareEvalBattery({
      skillDir: fixture.skillDir,
      evalsPath,
      outputRoot: path.join(fixture.root, "battery"),
    });
    expect(
      await readFile(
        path.join(result.actorRunsDir, "eval-1", "baseline", "fixtures", "parser.ts"),
        "utf8",
      ),
    ).toBe("DEBUG: request failed\n");
  });

  it("rejects staged content markers and does not honor the name hatch for them", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    await writeFile(
      path.join(fixture.skillDir, "evals", "files", "parser.ts"),
      "// TODO: the off-by-one\n",
    );
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [{ id: 1, prompt: "Review parser.ts", files: ["evals/files/parser.ts"] }],
      }),
    );
    const outputRoot = path.join(fixture.root, "battery");

    await expect(
      prepareEvalBattery({
        skillDir: fixture.skillDir,
        evalsPath,
        outputRoot,
        allowFixtureNameGlobs: ["parser.ts"],
      }),
    ).rejects.toThrow(/\[EVAL_FIXTURE_LEAK\].*TODO/);
    await expect(readFile(path.join(outputRoot, "controller", "manifest.json"))).rejects.toThrow();
  });

  it("rejects a directory fixture before reading contents", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    const directoryFixture = path.join(fixture.skillDir, "evals", "files", "sample-dir");
    await mkdir(directoryFixture);
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [{ id: 1, prompt: "Review sample-dir", files: ["evals/files/sample-dir"] }],
      }),
    );
    const outputRoot = path.join(fixture.root, "battery");

    await expect(
      prepareEvalBattery({ skillDir: fixture.skillDir, evalsPath, outputRoot }),
    ).rejects.toThrow(/not a regular file.*FIFO/i);
    await expect(readFile(path.join(outputRoot, "controller", "manifest.json"))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO fixture before reading contents",
    async () => {
      const fixture = await createSkillFixture();
      const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
      const fifoFixture = path.join(fixture.skillDir, "evals", "files", "sample.pipe");
      const created = spawnSync("mkfifo", [fifoFixture], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);
      await writeFile(
        evalsPath,
        JSON.stringify({
          skill_name: "example-skill",
          evals: [{ id: 1, prompt: "Review sample.pipe", files: ["evals/files/sample.pipe"] }],
        }),
      );
      const outputRoot = path.join(fixture.root, "battery");

      await expect(
        prepareEvalBattery({ skillDir: fixture.skillDir, evalsPath, outputRoot }),
      ).rejects.toThrow(/not a regular file.*FIFO/i);
      await expect(
        readFile(path.join(outputRoot, "controller", "manifest.json")),
      ).rejects.toThrow();
    },
  );

  it("prepares a denylisted filename when --allow-fixture-name covers it", async () => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    await writeFile(
      path.join(fixture.skillDir, "evals", "files", "MOTION-stale.md"),
      "duration: 300",
    );
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: "example-skill",
        evals: [{ id: 1, prompt: "Review CONFIG.md", files: ["evals/files/MOTION-stale.md"] }],
      }),
    );

    const result = await prepareEvalBattery({
      skillDir: fixture.skillDir,
      evalsPath,
      outputRoot: path.join(fixture.root, "battery"),
      allowFixtureNameGlobs: ["MOTION-stale.md"],
    });
    expect(
      await readFile(
        path.join(result.actorRunsDir, "eval-1", "baseline", "fixtures", "MOTION-stale.md"),
        "utf8",
      ),
    ).toBe("duration: 300");
  });

  it.each([
    "",
    ".",
    "..",
    "nested/skill",
    "nested\\skill",
    "/absolute",
    "C:\\absolute",
    "CON",
    "CONIN$",
    "CONOUT$.txt",
    "CLOCK$",
    "nul.txt",
    "COM1",
    "LPT9.log",
    "foo:bar",
    "trailing.",
    "trailing ",
    "é".repeat(128),
  ])("rejects unsafe skill_name %j before creating output", async (skillName) => {
    const fixture = await createSkillFixture();
    const evalsPath = path.join(fixture.skillDir, "evals", "evals.json");
    const outputRoot = path.join(fixture.root, "battery");
    await writeFile(
      evalsPath,
      JSON.stringify({
        skill_name: skillName,
        evals: [{ id: 1, prompt: "Review the fixture.", files: [] }],
      }),
    );

    await expect(
      prepareEvalBattery({ skillDir: fixture.skillDir, evalsPath, outputRoot }),
    ).rejects.toThrow(/skill_name/i);
    await expect(readFile(path.join(outputRoot, "controller", "manifest.json"))).rejects.toThrow();
  });
});
