import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { sanitizeDiagnostic } from "../diagnostics.js";

/** Directory, relative to an actor run directory, that holds staged eval fixtures. */
export const EVAL_FIXTURES_DIR_NAME = "fixtures";

/** Prepared case metadata file, relative to an actor run directory. */
export const EVAL_CASE_FILE_NAME = "case.json";

const MAX_CASE_FILE_BYTES = 256 * 1024;
const MAX_LISTED_FIXTURES = 20;
const MAX_STAGED_PATH_LENGTH = 1_024;
const MAX_STAGED_FILES = 500;

export interface StagedEvalFixture {
  /** Fixture path as written in `evals.json`, relative to the source skill. */
  readonly sourcePath: string;
  /** Actor-visible fixture path, relative to the prepared run directory. */
  readonly stagedPath: string;
}

export interface PreparedEvalCase {
  readonly id?: number;
  readonly stagedFiles: readonly string[];
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function withoutLeadingDot(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function sourceSpellings(fixture: StagedEvalFixture): string[] {
  const sourcePosix = withoutLeadingDot(toPosix(fixture.sourcePath));
  const stagedPosix = toPosix(fixture.stagedPath);
  const stagedRelative = stagedPosix.startsWith(`${EVAL_FIXTURES_DIR_NAME}/`)
    ? stagedPosix.slice(EVAL_FIXTURES_DIR_NAME.length + 1)
    : stagedPosix;
  const spellings = [sourcePosix, stagedRelative];
  return [
    ...spellings,
    ...spellings.map((spelling) => `./${spelling}`),
    ...spellings.map((spelling) => spelling.split("/").join("\\")),
  ];
}

/** Basenames are only unambiguous when exactly one staged fixture uses them. */
function unambiguousBasenames(fixtures: readonly StagedEvalFixture[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const fixture of fixtures) {
    const basename = path.posix.basename(toPosix(fixture.stagedPath));
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  const unambiguous = new Map<string, string>();
  for (const fixture of fixtures) {
    const basename = path.posix.basename(toPosix(fixture.stagedPath));
    if (counts.get(basename) === 1) unambiguous.set(basename, toPosix(fixture.stagedPath));
  }
  return unambiguous;
}

const PATH_CHARACTER = /[A-Za-z0-9_./\\-]/;
const PATH_CONTINUATION = /[A-Za-z0-9_/\\-]/;

function startsPathToken(prompt: string, start: number): boolean {
  const previous = prompt[start - 1];
  return previous === undefined || !PATH_CHARACTER.test(previous);
}

function endsPathToken(prompt: string, end: number): boolean {
  const next = prompt[end];
  if (next === undefined) return true;
  if (PATH_CONTINUATION.test(next)) return false;
  if (next === ".") return !/[A-Za-z0-9]/.test(prompt[end + 1] ?? "");
  return true;
}

/**
 * Rewrites source-relative fixture references so an actor can open them from its
 * run directory. Prepared batteries stage fixtures one directory down, so a prompt
 * that names the source file would otherwise send actors searching for it.
 */
export function stagePromptFixtureReferences(
  prompt: string,
  fixtures: readonly StagedEvalFixture[],
): string {
  if (fixtures.length === 0) return prompt;
  const replacements = new Map<string, string>();
  const ambiguous = new Set<string>();
  // A staged path always identifies its own fixture, even when another fixture
  // stages a file whose source spelling happens to match it.
  const reserved = new Set(fixtures.map((fixture) => toPosix(fixture.stagedPath)));
  for (const staged of reserved) replacements.set(staged, staged);
  const record = (needle: string, staged: string): void => {
    if (needle.length === 0 || ambiguous.has(needle) || reserved.has(needle)) return;
    const existing = replacements.get(needle);
    if (existing !== undefined && existing !== staged) {
      replacements.delete(needle);
      ambiguous.add(needle);
      return;
    }
    replacements.set(needle, staged);
  };
  for (const fixture of fixtures) {
    const staged = toPosix(fixture.stagedPath);
    for (const spelling of sourceSpellings(fixture)) record(spelling, staged);
  }
  for (const [basename, staged] of unambiguousBasenames(fixtures)) {
    record(basename, staged);
    record(`./${basename}`, staged);
  }

  const needles = [...replacements.keys()].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  if (needles.length === 0) return prompt;
  const pattern = new RegExp(needles.map(escapeRegExp).join("|"), "g");
  return prompt.replaceAll(pattern, (match, offset: number) => {
    const staged = replacements.get(match);
    if (staged === undefined) return match;
    if (!startsPathToken(prompt, offset) || !endsPathToken(prompt, offset + match.length)) {
      return match;
    }
    return staged;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function isSafeStagedPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STAGED_PATH_LENGTH) {
    return false;
  }
  // Prepared run directories stay writable for the actor, so treat the case file as untrusted.
  if (hasControlCharacter(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

async function readBoundedCaseFile(casePath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // A prior actor can replace the case file: opening it must not follow a link
    // out of the run directory, and must not block on a FIFO with no writer.
    handle = await open(
      casePath,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const details = await handle.stat();
    if (!details.isFile() || details.size === 0 || details.size > MAX_CASE_FILE_BYTES) {
      return undefined;
    }
    const buffer = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Reads the prepared case metadata of an actor run directory. It never throws:
 * `eval run` accepts any directory, and the file is actor-writable once a run starts.
 */
export async function readPreparedEvalCase(runDir: string): Promise<PreparedEvalCase | undefined> {
  const contents = await readBoundedCaseFile(path.join(runDir, EVAL_CASE_FILE_NAME));
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const stagedFiles = files.filter(isSafeStagedPath).slice(0, MAX_STAGED_FILES);
  const id = parsed.id;
  return {
    ...(Number.isInteger(id) ? { id: id as number } : {}),
    stagedFiles,
  };
}

/** Stable stderr lines telling operators where a prepared actor finds its fixtures. */
export function formatEvalActorContract(
  runDir: string,
  preparedCase: PreparedEvalCase | undefined,
): string[] {
  const lines = [
    `[PIONEER_EVAL_ACTOR_CONTRACT] actor working directory ${sanitizeDiagnostic(runDir)}; staged fixtures are relative paths under ${EVAL_FIXTURES_DIR_NAME}/; the prepared prompt and staged file list are in ${EVAL_CASE_FILE_NAME}`,
  ];
  const stagedFiles = preparedCase?.stagedFiles ?? [];
  for (const stagedFile of stagedFiles.slice(0, MAX_LISTED_FIXTURES)) {
    // The run directory stays actor-writable, so the listed names are sanitized
    // before they reach the operator's terminal.
    lines.push(`[PIONEER_EVAL_FIXTURES] ${sanitizeDiagnostic(stagedFile)}`);
  }
  const omitted = stagedFiles.length - MAX_LISTED_FIXTURES;
  if (omitted > 0) {
    lines.push(
      `[PIONEER_EVAL_FIXTURES] ${omitted} more staged files listed in ${EVAL_CASE_FILE_NAME}`,
    );
  }
  return lines;
}
