import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvalWorkspace,
  type EvalWorkspace,
  nativeEvalSandboxAvailable,
  runPioneer,
  SCRIPTED_CREDENTIAL_MARKER,
} from "./support/harness.js";
import {
  ACTOR_INVOCATION_FILE,
  type ScriptedActorInvocation,
  writeScriptedPi,
} from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();
const workspaces: EvalWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.remove()));
});

async function workspace(name: string): Promise<{ created: EvalWorkspace; runDir: string }> {
  const created = await createEvalWorkspace(name);
  workspaces.push(created);
  const runDir = path.join(created.root, "run");
  await mkdir(runDir);
  return { created, runDir };
}

interface WorkLogRecord {
  readonly type?: string;
  readonly stage?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
}

async function readWorkLog(logPath: string): Promise<WorkLogRecord[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as WorkLogRecord);
}

describe.skipIf(!sandboxReady)("pioneer eval run actor lifecycle", () => {
  it("completes a minimal no-tools Pi actor with exactly the requested output", async () => {
    const { created, runDir } = await workspace("minimal-actor");
    await writeScriptedPi(created, { actor: { kind: "reply-verbatim" } });

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("minimal-actor"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--no-tools",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("OK\n");
    expect(run.stderr).not.toContain("[EVAL_");
  });

  it("gives the isolated Pi home the credential locks current Pi creates", async () => {
    const { created, runDir } = await workspace("credential-lock");
    await writeScriptedPi(created, { actor: { kind: "credential-lock" } });
    const workLogPath = created.workLogPath("credential-lock");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      workLogPath,
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.stderr).not.toMatch(/EPERM|lock-failed/);
    expect(run.exitCode).toBe(0);
    const actorResult = JSON.parse(run.stdout) as {
      agentDir: string;
      credentialsReadable: boolean;
      locks: string;
    };
    expect(actorResult).toMatchObject({ credentialsReadable: true, locks: "created" });
    // The snapshot lives outside the persistent run directory and is removed afterwards.
    expect(path.relative(runDir, actorResult.agentDir).startsWith("..")).toBe(true);
    expect(existsSync(actorResult.agentDir)).toBe(false);
    expect(await readFile(path.join(created.piHome, "auth.json"), "utf8")).toContain(
      SCRIPTED_CREDENTIAL_MARKER,
    );
  });

  it("starts Pi actors with the documented fast-start flags and an isolated agent directory", async () => {
    const { created, runDir } = await workspace("startup-flags");
    await writeScriptedPi(created, { actor: { kind: "credential-lock" } });

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("startup-flags"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode).toBe(0);
    const invocation = JSON.parse(
      await readFile(path.join(runDir, ACTOR_INVOCATION_FILE), "utf8"),
    ) as ScriptedActorInvocation;
    expect(invocation.argv).toEqual(
      expect.arrayContaining([
        "--offline",
        "--no-session",
        "--no-approve",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--no-skills",
      ]),
    );
    expect(invocation.cwd).toBe(runDir);
    expect(invocation.piAgentDir).not.toBeNull();
    expect(path.relative(runDir, invocation.piAgentDir ?? "").startsWith("..")).toBe(true);
  });

  it("writes a stage work log that never records prompts or credentials", async () => {
    const { created, runDir } = await workspace("work-log");
    await writeScriptedPi(created, { actor: { kind: "credential-lock" } });
    const workLogPath = created.workLogPath("stages");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      workLogPath,
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--print",
      "unmistakable-prompt-text",
    ]);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(`[PIONEER_EVAL_WORK_LOG] ${workLogPath}`);
    const records = await readWorkLog(workLogPath);
    expect(records.map((record) => record.stage).filter(Boolean)).toEqual(
      expect.arrayContaining([
        "sandbox_readiness",
        "pi_readiness",
        "pi_home_snapshot",
        "network_proxy",
        "isolation_probe",
        "actor",
        "cleanup",
      ]),
    );
    expect(records.at(-1)?.type).toBe("eval_completed");
    const raw = await readFile(workLogPath, "utf8");
    expect(raw).not.toContain("unmistakable-prompt-text");
    expect(raw).not.toContain(SCRIPTED_CREDENTIAL_MARKER);
  });

  it("kills a hanging actor process tree and still returns its captured output", async () => {
    const { created, runDir } = await workspace("timeout");
    await writeScriptedPi(created, { actor: { kind: "hang-with-descendant" } });
    const workLogPath = created.workLogPath("timeout");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      workLogPath,
      "--timeout-ms",
      "2000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toContain("scripted-actor-started");
    expect(run.stderr).toContain("scripted-actor-thinking");
    expect(run.stderr).toContain("[EVAL_TIMEOUT]");
    // The timeout terminates the descendant that holds the inherited pipes, so the
    // controller settles promptly instead of waiting for its own hard kill.
    expect(run.durationMs).toBeLessThan(30_000);
    const records = await readWorkLog(workLogPath);
    expect(records.some((record) => record.stage === "actor" && record.timedOut === true)).toBe(
      true,
    );
    expect(records.at(-1)?.type).toBe("eval_completed");
  });
});
