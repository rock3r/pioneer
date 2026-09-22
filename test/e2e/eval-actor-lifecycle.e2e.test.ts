import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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

  it.each([
    ["pi command", "pi", "load"],
    ["declared cli.js path", "cli.js", "load"],
    ["declared cli.js without extensions", "cli.js", "builtin"],
  ] as const)(
    "loads an enabled user extension inside the sandboxed Pi actor (%s)",
    async (label, entry, mode) => {
      const { created, runDir } = await workspace(
        `extension-provider-${label.replaceAll(" ", "-")}`,
      );
      const extensionDirectory = path.join(created.root, "user-extensions");
      const extensionSource = path.join(extensionDirectory, "provider.ts");
      const extensionMarker = "extension-provider-marker\n";
      const cliPath = path.join(created.piPackageRoot, "dist", "cli.js");
      await mkdir(extensionDirectory);
      await writeFile(extensionSource, extensionMarker);
      await mkdir(path.join(created.piPackageRoot, "dist", "core"), { recursive: true });
      await writeFile(
        path.join(created.piPackageRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "@earendil-works/pi-coding-agent",
            version: "0.84.2",
            type: "module",
            bin: { pi: "dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        cliPath,
        `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.84.2\\n");
  process.exit(0);
}
if (argv.includes("--list-models")) {
  process.stdout.write(
    "provider  model  context  max-out  thinking  images\\nextension-provider  demo  1K  1K  no  no\\n",
  );
  process.exit(0);
}
if (argv.includes("--no-extensions") && !argv.includes("--extension")) {
  fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
}
const extensionIndex = argv.indexOf("--extension");
const extensionPath = extensionIndex < 0 ? undefined : argv[extensionIndex + 1];
let extensionText = "";
if (extensionPath !== undefined) extensionText = fs.readFileSync(extensionPath, "utf8");
fs.writeFileSync(
  path.join(process.cwd(), ${JSON.stringify(ACTOR_INVOCATION_FILE)}),
  JSON.stringify({
    argv,
    cwd: process.cwd(),
    piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    extensionText,
  }) + "\\n",
);
process.stdout.write("READY\\n");
`,
        { mode: 0o755 },
      );
      await symlink(cliPath, path.join(created.binDir, "pi"));
      await writeFile(
        path.join(created.piPackageRoot, "dist", "core", "settings-manager.js"),
        "export const SettingsManager = { inMemory() { return {}; } };\n",
      );
      await writeFile(
        path.join(created.piPackageRoot, "dist", "core", "package-manager.js"),
        `export class DefaultPackageManager {
  async resolve() {
    return {
      extensions: [
        {
          path: ${JSON.stringify(extensionSource)},
          enabled: true,
          metadata: { scope: "user" },
        },
      ],
    };
  }
}
`,
      );
      await writeFile(
        path.join(created.piPackageRoot, "dist", "core", "resource-loader.js"),
        "export class DefaultResourceLoader { getExtensions() { return { extensions: [], errors: [] }; } }\n",
      );

      const run = await runPioneer(created, [
        "eval",
        "run",
        "--run-dir",
        runDir,
        "--pi-home",
        created.piHome,
        "--work-log",
        created.workLogPath(`extension-provider-${label.replaceAll(" ", "-")}`),
        "--timeout-ms",
        "60000",
        "--",
        entry === "cli.js" ? cliPath : "pi",
        ...(mode === "builtin" ? (["--no-extensions"] as const) : []),
        "--model",
        "extension-provider/demo",
        "--print",
        "Say READY",
      ]);

      expect(run.stderr).not.toMatch(/PI_EXTENSION_|PI_OAUTH_/);
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("READY");
      const invocation = JSON.parse(
        await readFile(path.join(runDir, ACTOR_INVOCATION_FILE), "utf8"),
      ) as ScriptedActorInvocation & { extensionText?: string };
      if (mode === "builtin") {
        expect(invocation.argv).toEqual(
          expect.arrayContaining([
            "--offline",
            "--no-session",
            "--no-approve",
            "--no-skills",
            "--no-extensions",
          ]),
        );
        expect(invocation.argv).not.toContain("--extension");
        expect(invocation.extensionText).toBe("");
      } else {
        expect(invocation.argv).toEqual(expect.arrayContaining(["--no-extensions", "--extension"]));
        expect(invocation.extensionText).toBe(extensionMarker);
      }
    },
  );

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
