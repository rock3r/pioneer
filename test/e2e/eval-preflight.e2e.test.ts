import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvalWorkspace,
  createSkillFixture,
  type EvalWorkspace,
  nativeEvalSandboxAvailable,
  parsePreparedBattery,
  runPioneer,
} from "./support/harness.js";
import {
  ACTOR_INVOCATION_FILE,
  type ScriptedPiOptions,
  writeScriptedPi,
} from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();
const workspaces: EvalWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.remove()));
});

async function preflightWorkspace(
  name: string,
  scriptedPi: ScriptedPiOptions,
): Promise<{ created: EvalWorkspace; runDir: string }> {
  const created = await createEvalWorkspace(name);
  workspaces.push(created);
  await writeScriptedPi(created, scriptedPi);
  const runDir = path.join(created.root, "run");
  await mkdir(runDir);
  return { created, runDir };
}

function evalRunArgs(
  created: EvalWorkspace,
  runDir: string,
  model: string,
  logName: string,
): string[] {
  return [
    "eval",
    "run",
    "--run-dir",
    runDir,
    "--pi-home",
    created.piHome,
    "--work-log",
    created.workLogPath(logName),
    "--timeout-ms",
    "60000",
    "--",
    "pi",
    "--model",
    model,
    "--print",
    "Reply with exactly: OK",
  ];
}

describe.skipIf(!sandboxReady)("pioneer eval run preflight fails closed", () => {
  it("rejects a Pi build without the --no-approve project-trust control", async () => {
    const { created, runDir } = await preflightWorkspace("no-approve", {
      rejectNoApprove: true,
      actor: { kind: "credential-lock" },
    });

    const run = await runPioneer(
      created,
      evalRunArgs(created, runDir, "scripted/fake-model", "no-approve"),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("[PI_CLI_INCOMPATIBLE]");
    expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
  });

  it("rejects a Pi home without configured models", async () => {
    const { created, runDir } = await preflightWorkspace("no-models", {
      models: [],
      actor: { kind: "credential-lock" },
    });

    const run = await runPioneer(
      created,
      evalRunArgs(created, runDir, "scripted/fake-model", "no-models"),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/\[PI_NO_MODELS]|\[PI_CONFIG_HIDDEN_BY_SANDBOX]/);
    expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
  });

  it("rejects an unconfigured model and reports the configured catalog", async () => {
    const { created, runDir } = await preflightWorkspace("unknown-model", {
      models: ["scripted/fake-model", "scripted/other-model"],
      actor: { kind: "credential-lock" },
    });

    const run = await runPioneer(
      created,
      evalRunArgs(created, runDir, "scripted/missing-model", "unknown-model"),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("Configured Pi models:");
    expect(run.stderr).toContain("scripted/fake-model");
    expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
  });

  it("rejects an unloadable Pi models configuration", async () => {
    const { created, runDir } = await preflightWorkspace("invalid-models", {
      invalidModelsConfig: true,
      actor: { kind: "credential-lock" },
    });

    const run = await runPioneer(
      created,
      evalRunArgs(created, runDir, "scripted/fake-model", "invalid-models"),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("[PI_MODELS_CONFIG_INVALID]");
    expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
  });
});

describe.skipIf(!sandboxReady)(
  "pioneer eval run keeps controller material away from actors",
  () => {
    it("denies the controller manifest, the sibling arm, and the source eval definitions", async () => {
      const created = await createEvalWorkspace("actor-isolation");
      workspaces.push(created);
      const skill = await createSkillFixture(created, {
        files: [{ relativePath: "fixture_44.kt", contents: "class Fixture44\n" }],
        cases: [
          {
            id: 44,
            prompt: "Review fixture_44.kt",
            files: ["evals/files/fixture_44.kt"],
            expectedOutput: "answer-key",
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
      const runDir = battery.runDir(44, "with-skill");
      const controllerManifest = path.join(battery.controllerDir, "manifest.json");
      const siblingCase = path.join(battery.runDir(44, "baseline"), "case.json");
      await writeScriptedPi(created, {
        actor: {
          kind: "probe-denied-reads",
          deniedPaths: [controllerManifest, siblingCase, skill.evalsPath],
        },
      });

      const run = await runPioneer(created, [
        "eval",
        "run",
        "--run-dir",
        runDir,
        "--pi-home",
        created.piHome,
        "--work-log",
        created.workLogPath("actor-isolation"),
        "--deny-read-probe",
        controllerManifest,
        "--deny-read-probe",
        skill.evalsPath,
        "--timeout-ms",
        "60000",
        "--",
        "pi",
        "--model",
        "scripted/fake-model",
        "--print",
        "Report readable controller paths.",
      ]);

      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ readable: [] });
    });
  },
);
