import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareEvalBattery } from "./setup.js";

async function createSkillFixture(): Promise<{ root: string; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pioneer-battery-"));
  const skillDir = path.join(root, "example-skill");
  await mkdir(path.join(skillDir, "evals", "files"), { recursive: true });
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: example-skill\ndescription: Example\n---\n\n# Example\n",
  );
  await writeFile(path.join(skillDir, "references", "guide.md"), "safe reference");
  await writeFile(path.join(skillDir, "skill-source.json"), '{"secret":"provenance"}');
  await writeFile(path.join(skillDir, "evals", "files", "fixture.txt"), "prompt-safe fixture");
  await writeFile(
    path.join(skillDir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "example-skill",
      evals: [
        {
          id: 1,
          prompt: "Review the fixture.",
          expected_output: "Secret answer key",
          files: ["evals/files/fixture.txt"],
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
    expect(await readFile(path.join(baseline, "fixtures", "fixture.txt"), "utf8")).toBe(
      "prompt-safe fixture",
    );
    expect(await readFile(path.join(withSkill, "fixtures", "fixture.txt"), "utf8")).toBe(
      "prompt-safe fixture",
    );
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
});
