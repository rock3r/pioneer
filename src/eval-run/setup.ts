import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

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

export interface PreparedEvalBattery {
  readonly outputRoot: string;
  readonly actorRunsDir: string;
  readonly controllerDir: string;
  readonly skillName: string;
  readonly evalIds: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvalCases(value: unknown): { skillName: string; evals: EvalCase[] } {
  if (!isRecord(value) || typeof value.skill_name !== "string" || !Array.isArray(value.evals)) {
    throw new Error("Invalid evals.json: expected skill_name and evals");
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

function ensureWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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

  const outputRoot = path.resolve(options.outputRoot);
  ensureWithin(path.dirname(outputRoot), outputRoot, "output root");
  if (
    path.relative(skillDir, outputRoot) === "" ||
    !path.relative(skillDir, outputRoot).startsWith("..")
  ) {
    throw new Error("Eval battery output must be outside the source skill");
  }
  await mkdir(outputRoot);
  const actorRunsDir = path.join(outputRoot, "actor-runs");
  const controllerDir = path.join(outputRoot, "controller");
  await mkdir(actorRunsDir);
  await mkdir(controllerDir);

  const parsed = parseEvalCases(JSON.parse(await readFile(evalsPath, "utf8")) as unknown);
  for (const evalCase of parsed.evals) {
    for (const arm of ["baseline", "with-skill"] as const) {
      const runDir = path.join(actorRunsDir, `eval-${evalCase.id}`, arm);
      await mkdir(path.join(runDir, "fixtures"), { recursive: true });
      await mkdir(path.join(runDir, "home"), { recursive: true });
      await mkdir(path.join(runDir, "tmp"), { recursive: true });
      await mkdir(path.join(runDir, "work"), { recursive: true });

      const stagedFiles: string[] = [];
      for (const relativeFile of evalCase.files) {
        const source = path.resolve(skillDir, relativeFile);
        ensureWithin(skillDir, source, "fixture");
        const canonicalSource = await realpath(source);
        ensureWithin(skillDir, canonicalSource, "fixture");
        const destinationRelative = fixtureDestination(relativeFile);
        const destination = path.join(runDir, "fixtures", destinationRelative);
        ensureWithin(path.join(runDir, "fixtures"), destination, "fixture destination");
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(canonicalSource, destination, { force: false });
        stagedFiles.push(
          path.posix.join("fixtures", destinationRelative.split(path.sep).join("/")),
        );
      }

      await writeFile(
        path.join(runDir, "case.json"),
        `${JSON.stringify({ id: evalCase.id, prompt: evalCase.prompt, files: stagedFiles }, null, 2)}\n`,
        { flag: "wx" },
      );
      if (arm === "with-skill") {
        await copySanitizedSkill(skillDir, path.join(runDir, "skills", parsed.skillName));
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
  };
}
