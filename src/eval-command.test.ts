import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalCli } from "./eval-command.js";

interface CapturedOutput {
  readonly stdout: string[];
  readonly stderr: string[];
}

function capture(): CapturedOutput & {
  readonly write: { stdout: (text: string) => void; stderr: (text: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    write: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

async function createSkill(prompt: string): Promise<{ root: string; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pioneer-eval-cli-"));
  const skillDir = path.join(root, "example-skill");
  await mkdir(path.join(skillDir, "evals", "files"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# Example\n");
  await writeFile(path.join(skillDir, "evals", "files", "fixture_42.kt"), "class Fixture42\n");
  await writeFile(
    path.join(skillDir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "example-skill",
      evals: [{ id: 42, prompt, files: ["evals/files/fixture_42.kt"] }],
    }),
  );
  return { root, skillDir };
}

describe("pioneer eval prepare output", () => {
  it("returns the staged actor contract on stdout and documents it on stderr", async () => {
    const skill = await createSkill("Review this panel. File: fixture_42.kt");
    const output = capture();

    await runEvalCli(
      [
        "prepare",
        "--skill",
        skill.skillDir,
        "--evals",
        path.join(skill.skillDir, "evals", "evals.json"),
        "--output",
        path.join(skill.root, "battery"),
      ],
      "pioneer eval",
      output.write,
    );

    const prepared = JSON.parse(output.stdout.join("")) as {
      actorContract: { fixturesDir: string; caseFile: string; promptField: string };
    };
    expect(prepared.actorContract.fixturesDir).toBe("fixtures");
    expect(prepared.actorContract.caseFile).toBe("case.json");
    expect(prepared.actorContract.promptField).toBe("prompt");
    expect(output.stderr.join("")).toContain("[PIONEER_EVAL_ACTOR_CONTRACT]");
    expect(output.stderr.join("")).toContain("fixtures/");
  });
});

describe("pioneer eval usage", () => {
  it("keeps the documented run and prepare forms", async () => {
    const output = capture();

    await runEvalCli(["--help"], "pioneer eval", output.write);

    expect(output.stdout.join("")).toContain("prepare --skill DIR --evals FILE --output DIR");
    expect(output.stdout.join("")).toContain("run --run-dir DIR");
  });
});
