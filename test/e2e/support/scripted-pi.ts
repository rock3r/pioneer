import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalWorkspace } from "./harness.js";

/**
 * Behaviour of the scripted actor once Pioneer launches it inside the sandbox.
 * Every variant is deterministic and offline: no provider is ever contacted.
 */
export type ScriptedPiActor =
  /** Replies with the text a `Reply with exactly: TEXT` prompt requests. */
  | { readonly kind: "reply-verbatim" }
  /** Opens exactly the files the prompt names, relative to the actor working directory. */
  | { readonly kind: "review-referenced-files" }
  /** Lists the run directory and `fixtures/` without spawning a search process. */
  | { readonly kind: "list-run-directory" }
  /** Creates the Pi credential lock files beside the snapshotted configuration. */
  | { readonly kind: "credential-lock" }
  /** Leaks a descendant that keeps the inherited pipes open, then hangs forever. */
  | { readonly kind: "hang-with-descendant" }
  /** Reports which controller-owned paths the sandbox left readable. */
  | { readonly kind: "probe-denied-reads"; readonly deniedPaths: readonly string[] };

export interface ScriptedPiOptions {
  readonly version?: string;
  /** Qualified `provider/model` names reported by `--list-models`. */
  readonly models?: readonly string[];
  /** Reproduces a Pi build without the `--no-approve` project-trust control. */
  readonly rejectNoApprove?: boolean;
  /** Reproduces an unreadable `models.json`. */
  readonly invalidModelsConfig?: boolean;
  readonly actor: ScriptedPiActor;
}

export interface ScriptedPiScenario {
  readonly version: string;
  readonly models: readonly string[];
  readonly rejectNoApprove: boolean;
  readonly invalidModelsConfig: boolean;
  readonly actor: ScriptedPiActor;
}

/** File the scripted actor writes into its working directory on every launch. */
export const ACTOR_INVOCATION_FILE = "actor-invocation.json";

export interface ScriptedActorInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly piAgentDir: string | null;
}

const SCRIPT_BODY = String.raw`const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const optionValue = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const fail = (message) => {
  process.stderr.write(message + "\n");
  process.exit(1);
};

if (argv.includes("--version")) {
  process.stdout.write(SCENARIO.version + "\n");
  process.exit(0);
}

if (argv.includes("--list-models")) {
  if (SCENARIO.rejectNoApprove && argv.includes("--no-approve")) {
    fail("error: unknown option '--no-approve'");
  }
  if (SCENARIO.invalidModelsConfig) {
    fail("Errors loading models.json: unexpected token");
  }
  if (SCENARIO.models.length === 0) {
    process.stdout.write("No models available.\n");
    process.exit(0);
  }
  const rows = SCENARIO.models.map((qualified) => {
    const separator = qualified.indexOf("/");
    const provider = qualified.slice(0, separator);
    const model = qualified.slice(separator + 1);
    return provider + "  " + model + "  1K  1K  no  no";
  });
  process.stdout.write(
    ["provider  model  context  max-out  thinking  images", ...rows].join("\n") + "\n",
  );
  process.exit(0);
}

fs.writeFileSync(
  path.join(process.cwd(), INVOCATION_FILE),
  JSON.stringify(
    { argv, cwd: process.cwd(), piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null },
    null,
    2,
  ) + "\n",
);

const actor = SCENARIO.actor;

if (actor.kind === "reply-verbatim") {
  const requested = /Reply with exactly:\s*(.+)$/m.exec(optionValue("--print") ?? "");
  if (requested === null) fail("scripted-model-received-no-instruction");
  process.stdout.write(requested[1].trim() + "\n");
  process.exit(0);
}

if (actor.kind === "review-referenced-files") {
  const prompt = optionValue("--print") ?? "";
  const references = [...new Set(prompt.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+/g) ?? [])];
  const reviewed = [];
  for (const reference of references) {
    let contents;
    try {
      contents = fs.readFileSync(path.resolve(process.cwd(), reference), "utf8");
    } catch (error) {
      // A sandboxed actor has no shell fallback, so a missing path ends the case.
      fail("I can't locate " + reference + " (" + (error.code ?? error.message) + ")");
    }
    reviewed.push({ file: reference, firstLine: contents.split("\n")[0] });
  }
  const skillDir = optionValue("--skill");
  let skill = null;
  if (skillDir !== undefined) {
    try {
      skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8").trim();
    } catch (error) {
      skill = "unreadable:" + (error.code ?? error.message);
    }
  }
  process.stdout.write(
    JSON.stringify({ model: optionValue("--model") ?? null, reviewed, skill }) + "\n",
  );
  process.exit(0);
}

if (actor.kind === "list-run-directory") {
  const fixturesDir = path.join(process.cwd(), "fixtures");
  let preparedCase = null;
  try {
    preparedCase = JSON.parse(fs.readFileSync(path.join(process.cwd(), "case.json"), "utf8"));
  } catch (error) {
    preparedCase = { error: error.code ?? error.message };
  }
  process.stdout.write(
    JSON.stringify({
      entries: fs.readdirSync(process.cwd()).sort(),
      fixtures: fs.existsSync(fixturesDir) ? fs.readdirSync(fixturesDir).sort() : null,
      preparedCase,
    }) + "\n",
  );
  process.exit(0);
}

if (actor.kind === "credential-lock") {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) fail("missing-agent-dir");
  if (!path.relative(process.cwd(), agentDir).startsWith("..")) fail("pi-home-not-externalized");
  for (const name of ["auth.json.lock", "settings.json.lock"]) {
    try {
      const lockDir = path.join(agentDir, name);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), "scripted-eval-lock");
    } catch (error) {
      fail("lock-failed:" + name + ":" + (error.code ?? error.message));
    }
  }
  const auth = fs.readFileSync(path.join(agentDir, "auth.json"), "utf8");
  process.stdout.write(
    JSON.stringify({ agentDir, credentialsReadable: auth.includes("token"), locks: "created" }) +
      "\n",
  );
  process.exit(0);
}

if (actor.kind === "hang-with-descendant") {
  spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "inherit" });
  process.stdout.write("scripted-actor-started\n");
  process.stderr.write("scripted-actor-thinking\n");
  setInterval(() => {}, 10000);
  return;
}

if (actor.kind === "probe-denied-reads") {
  const readable = [];
  for (const deniedPath of actor.deniedPaths) {
    try {
      fs.readFileSync(deniedPath);
      readable.push(deniedPath);
    } catch {
      // Expected: the path is outside every actor grant.
    }
  }
  process.stdout.write(JSON.stringify({ readable }) + "\n");
  process.exit(0);
}

fail("unknown-scripted-actor");
`;

/**
 * Writes a scripted stand-in for the Pi coding agent: a package Pioneer accepts as a
 * validated Pi installation whose model provider is a deterministic local script.
 * It needs no API key and never opens a network connection.
 */
export async function writeScriptedPi(
  workspace: EvalWorkspace,
  options: ScriptedPiOptions,
): Promise<string> {
  const scenario: ScriptedPiScenario = {
    version: options.version ?? "0.84.2",
    models: options.models ?? ["scripted/fake-model"],
    rejectNoApprove: options.rejectNoApprove ?? false,
    invalidModelsConfig: options.invalidModelsConfig ?? false,
    actor: options.actor,
  };
  await writeFile(
    path.join(workspace.piPackageRoot, "package.json"),
    `${JSON.stringify(
      { name: "@earendil-works/pi-coding-agent", version: scenario.version, bin: { pi: "bin/pi" } },
      null,
      2,
    )}\n`,
  );
  const executable = path.join(workspace.binDir, "pi");
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      `"use strict";`,
      `const SCENARIO = ${JSON.stringify(scenario)};`,
      `const INVOCATION_FILE = ${JSON.stringify(ACTOR_INVOCATION_FILE)};`,
      SCRIPT_BODY,
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}
