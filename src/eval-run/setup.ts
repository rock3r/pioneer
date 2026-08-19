import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVAL_CASE_FILE_NAME,
  EVAL_FIXTURES_DIR_NAME,
  type StagedEvalFixture,
  stagePromptFixtureReferences,
} from "./actor-contract.js";

interface EvalCase {
  readonly id: number;
  readonly prompt: string;
  readonly files: readonly string[];
}

export interface PrepareEvalBatteryOptions {
  readonly skillDir: string;
  readonly evalsPath: string;
  readonly outputRoot: string;
}

export interface PreparedEvalActorContract {
  readonly caseFile: string;
  readonly fixturesDir: string;
  readonly promptField: string;
  readonly description: string;
}

export interface PreparedEvalBattery {
  readonly outputRoot: string;
  readonly actorRunsDir: string;
  readonly controllerDir: string;
  readonly skillName: string;
  readonly evalIds: readonly number[];
  readonly actorContract: PreparedEvalActorContract;
}

const PREPARED_ACTOR_CONTRACT: PreparedEvalActorContract = {
  caseFile: EVAL_CASE_FILE_NAME,
  fixturesDir: EVAL_FIXTURES_DIR_NAME,
  promptField: "prompt",
  description: `Run each actor with its run directory as the working directory. Prepared prompts reference staged fixtures as ${EVAL_FIXTURES_DIR_NAME}/NAME relative to that directory, and ${EVAL_CASE_FILE_NAME} lists every staged file.`,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInvalidWindowsFilenameCharacter(value: string): boolean {
  return [...value].some(
    (character) => (character.codePointAt(0) ?? 0) <= 0x1f || '<>:"/\\|?*'.includes(character),
  );
}

function isSafeSkillName(value: string): boolean {
  const windowsReservedName =
    /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\.|$)/i;
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    value !== "." &&
    value !== ".." &&
    !hasInvalidWindowsFilenameCharacter(value) &&
    !/[. ]$/u.test(value) &&
    !windowsReservedName.test(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    path.posix.basename(value) === value &&
    path.win32.basename(value) === value
  );
}

function parseEvalCases(value: unknown): { skillName: string; evals: EvalCase[] } {
  if (!isRecord(value) || typeof value.skill_name !== "string" || !Array.isArray(value.evals)) {
    throw new Error("Invalid evals.json: expected skill_name and evals");
  }
  if (!isSafeSkillName(value.skill_name)) {
    throw new Error("Invalid evals.json: skill_name must be one safe path component");
  }
  const evals = value.evals.map((entry, index) => {
    if (!isRecord(entry) || !Number.isInteger(entry.id) || typeof entry.prompt !== "string") {
      throw new Error(`Invalid evals.json entry at index ${index}`);
    }
    const files = entry.files ?? [];
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
      throw new Error(`Invalid files list for eval ${String(entry.id)}`);
    }
    return { id: entry.id as number, prompt: entry.prompt, files: files as string[] };
  });
  const ids = new Set(evals.map(({ id }) => id));
  if (ids.size !== evals.length) {
    throw new Error("Invalid evals.json: eval ids must be unique");
  }
  return { skillName: value.skill_name, evals };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function ensureWithin(root: string, candidate: string, label: string): void {
  if (!isWithin(root, candidate)) {
    throw new Error(`${label} escapes its allowed root: ${candidate}`);
  }
}

async function assertTreeHasNoSymlinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error(`Source skill contains a symbolic link: ${candidate}`);
    }
    if (stats.isDirectory()) {
      await assertTreeHasNoSymlinks(candidate);
    }
  }
}

async function copySanitizedSkill(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      entry.name === "evals" ||
      entry.name === "skill-source.json" ||
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name.endsWith("-workspace")
    ) {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySanitizedSkill(from, to);
    } else if (entry.isFile()) {
      await cp(from, to, { force: false });
    }
  }
}

function fixtureDestination(relativeFile: string): string {
  const normalized = relativeFile.split(path.sep).join("/");
  const prefix = "evals/files/";
  return normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : path.basename(normalized);
}

export async function prepareEvalBattery(
  options: PrepareEvalBatteryOptions,
): Promise<PreparedEvalBattery> {
  const skillDir = await realpath(options.skillDir);
  const evalsPath = await realpath(options.evalsPath);
  ensureWithin(skillDir, evalsPath, "evals path");
  await assertTreeHasNoSymlinks(skillDir);
  const parsed = parseEvalCases(JSON.parse(await readFile(evalsPath, "utf8")) as unknown);

  const requestedOutputRoot = path.resolve(options.outputRoot);
  const outputParent = await realpath(path.dirname(requestedOutputRoot));
  let outputRoot = path.join(outputParent, path.basename(requestedOutputRoot));
  ensureWithin(outputParent, outputRoot, "output root");
  if (isWithin(skillDir, outputRoot)) {
    throw new Error("Eval battery output must be outside the source skill");
  }
  await mkdir(outputRoot);
  const createdOutputRoot = await realpath(outputRoot);
  if (path.dirname(createdOutputRoot) !== outputParent) {
    throw new Error("Eval battery output parent changed while the output was created");
  }
  if (isWithin(skillDir, createdOutputRoot)) {
    throw new Error("Eval battery output must be outside the source skill");
  }
  outputRoot = createdOutputRoot;
  const actorRunsDir = path.join(outputRoot, "actor-runs");
  const controllerDir = path.join(outputRoot, "controller");
  await mkdir(actorRunsDir);
  await mkdir(controllerDir);

  for (const evalCase of parsed.evals) {
    for (const arm of ["baseline", "with-skill"] as const) {
      const runDir = path.join(actorRunsDir, `eval-${evalCase.id}`, arm);
      await mkdir(path.join(runDir, EVAL_FIXTURES_DIR_NAME), { recursive: true });
      await mkdir(path.join(runDir, "home"), { recursive: true });
      await mkdir(path.join(runDir, "tmp"), { recursive: true });
      await mkdir(path.join(runDir, "work"), { recursive: true });

      const stagedFixtures: StagedEvalFixture[] = [];
      for (const relativeFile of evalCase.files) {
        const source = path.resolve(skillDir, relativeFile);
        ensureWithin(skillDir, source, "fixture");
        const canonicalSource = await realpath(source);
        ensureWithin(skillDir, canonicalSource, "fixture");
        const destinationRelative = fixtureDestination(relativeFile);
        const fixturesDir = path.join(runDir, EVAL_FIXTURES_DIR_NAME);
        const destination = path.join(fixturesDir, destinationRelative);
        ensureWithin(fixturesDir, destination, "fixture destination");
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(canonicalSource, destination, { force: false });
        stagedFixtures.push({
          sourcePath: relativeFile,
          stagedPath: path.posix.join(
            EVAL_FIXTURES_DIR_NAME,
            destinationRelative.split(path.sep).join("/"),
          ),
        });
      }

      await writeFile(
        path.join(runDir, EVAL_CASE_FILE_NAME),
        `${JSON.stringify(
          {
            id: evalCase.id,
            prompt: stagePromptFixtureReferences(evalCase.prompt, stagedFixtures),
            source_prompt: evalCase.prompt,
            fixtures_dir: EVAL_FIXTURES_DIR_NAME,
            files: stagedFixtures.map(({ stagedPath }) => stagedPath),
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      if (arm === "with-skill") {
        const skillsDir = path.join(runDir, "skills");
        const skillDestination = path.join(skillsDir, parsed.skillName);
        ensureWithin(skillsDir, skillDestination, "skill destination");
        await copySanitizedSkill(skillDir, skillDestination);
      }
    }
  }

  await writeFile(
    path.join(controllerDir, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        skill_name: parsed.skillName,
        eval_ids: parsed.evals.map(({ id }) => id),
        answer_keys_written: false,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );

  return {
    outputRoot,
    actorRunsDir,
    controllerDir,
    skillName: parsed.skillName,
    evalIds: parsed.evals.map(({ id }) => id),
    actorContract: PREPARED_ACTOR_CONTRACT,
  };
}
