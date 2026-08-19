import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeSandboxReadinessErrors } from "../../../src/sandbox/platform-readiness.js";

export const REPO_ROOT = path.dirname(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
);

export const PIONEER_CLI = path.join(REPO_ROOT, "dist", "review-cli.js");

/** Marker written into the scripted Pi home; no eval output or work log may contain it. */
export const SCRIPTED_CREDENTIAL_MARKER = "scripted-eval-credential-marker";

const DEFAULT_CLI_TIMEOUT_MS = 120_000;

export interface EvalWorkspace {
  /** Canonical disposable root holding every artifact of one e2e case. */
  readonly root: string;
  /** Snapshot source passed as `--pi-home`; never the operator's real Pi home. */
  readonly piHome: string;
  /** Directory prepended to `PATH` so `pi` resolves to the scripted installation. */
  readonly binDir: string;
  /** Package root of the scripted Pi installation. */
  readonly piPackageRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  workLogPath(name: string): string;
  remove(): Promise<void>;
}

export interface CliResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Eval actors only start behind the native sandbox, so run-time cases skip without it. */
export async function nativeEvalSandboxAvailable(): Promise<boolean> {
  return (await nativeSandboxReadinessErrors()).length === 0;
}

/** Platform runtime values the CLI needs; the workspace supplies everything else. */
function inheritedEnvironment(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of [
    "APPDATA",
    "ComSpec",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "windir",
  ]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

export async function createEvalWorkspace(name: string): Promise<EvalWorkspace> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `pioneer-e2e-${name}-`)));
  const piHome = path.join(root, "pi-home");
  const piPackageRoot = path.join(root, "pi-install");
  const binDir = path.join(piPackageRoot, "bin");
  const homeDir = path.join(root, "home");
  const cacheDir = path.join(root, "cache");
  const stateDir = path.join(root, "state");
  const logsDir = path.join(root, "work-logs");
  await Promise.all([
    mkdir(piHome),
    mkdir(binDir, { recursive: true }),
    mkdir(homeDir),
    mkdir(path.join(cacheDir, "pioneer"), { recursive: true }),
    mkdir(stateDir),
    mkdir(logsDir),
  ]);
  await Promise.all([
    writeFile(
      path.join(piHome, "auth.json"),
      `${JSON.stringify({ scripted: { token: SCRIPTED_CREDENTIAL_MARKER } })}\n`,
      { mode: 0o600 },
    ),
    writeFile(path.join(piHome, "settings.json"), "{}\n"),
    writeFile(path.join(piHome, "models.json"), "{}\n"),
    // A fresh cache entry keeps the CLI's background update check off the network.
    writeFile(
      path.join(cacheDir, "pioneer", "update-check.json"),
      `${JSON.stringify({ schemaVersion: 1, checkedAt: Date.now() })}\n`,
    ),
  ]);

  return {
    root,
    piHome,
    binDir,
    piPackageRoot,
    environment: {
      ...inheritedEnvironment(),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_STATE_HOME: stateDir,
      NO_COLOR: "1",
    },
    workLogPath: (logName: string) => path.join(logsDir, `${logName}.jsonl`),
    remove: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function runPioneer(
  workspace: EvalWorkspace,
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<CliResult> {
  const started = performance.now();
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [PIONEER_CLI, ...args], {
      cwd: workspace.root,
      env: workspace.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - started,
      });
    });
  });
}

export interface SkillFixtureFile {
  readonly relativePath: string;
  readonly contents: string;
}

export interface SkillFixtureCase {
  readonly id: number;
  readonly prompt: string;
  readonly files: readonly string[];
  readonly expectedOutput?: string;
  readonly expectations?: readonly string[];
}

/** Writes a source skill with an `evals/` battery, mirroring a real skill layout. */
export async function createSkillFixture(
  workspace: EvalWorkspace,
  options: {
    readonly skillName?: string;
    readonly files: readonly SkillFixtureFile[];
    readonly cases: readonly SkillFixtureCase[];
  },
): Promise<{ readonly skillDir: string; readonly evalsPath: string }> {
  const skillName = options.skillName ?? "example-skill";
  const skillDir = path.join(workspace.root, "skill");
  await mkdir(path.join(skillDir, "evals", "files"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Scripted eval skill\n---\n\n# ${skillName}\n`,
  );
  for (const file of options.files) {
    const destination = path.join(skillDir, "evals", "files", file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.contents);
  }
  const evalsPath = path.join(skillDir, "evals", "evals.json");
  await writeFile(
    evalsPath,
    `${JSON.stringify(
      {
        skill_name: skillName,
        evals: options.cases.map((evalCase) => ({
          id: evalCase.id,
          prompt: evalCase.prompt,
          files: evalCase.files,
          ...(evalCase.expectedOutput === undefined
            ? {}
            : { expected_output: evalCase.expectedOutput }),
          ...(evalCase.expectations === undefined ? {} : { expectations: evalCase.expectations }),
        })),
      },
      null,
      2,
    )}\n`,
  );
  return { skillDir, evalsPath };
}

export interface PreparedEvalBatteryPaths {
  readonly outputRoot: string;
  readonly actorRunsDir: string;
  readonly controllerDir: string;
  readonly actorContract: {
    readonly caseFile: string;
    readonly fixturesDir: string;
    readonly promptField: string;
    readonly description: string;
  };
  runDir(evalId: number, arm: "baseline" | "with-skill"): string;
}

export function parsePreparedBattery(stdout: string): PreparedEvalBatteryPaths {
  const parsed = JSON.parse(stdout) as Omit<PreparedEvalBatteryPaths, "runDir">;
  return {
    ...parsed,
    runDir: (evalId, arm) => path.join(parsed.actorRunsDir, `eval-${evalId}`, arm),
  };
}

export interface PreparedCaseFile {
  readonly id: number;
  readonly prompt: string;
  readonly source_prompt: string;
  readonly fixtures_dir: string;
  readonly files: readonly string[];
}
