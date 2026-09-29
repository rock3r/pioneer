import { StringDecoder } from "node:string_decoder";
import { EVAL_FIXTURES_DIR_NAME } from "./actor-contract.js";

const PATH_DENYLIST = new Set([
  "stale",
  "bug",
  "defect",
  "bad",
  "good",
  "broken",
  "wrong",
  "negative",
  "positive",
  "rough",
  "showcase",
  "expected",
  "fixture",
  "case",
]);

/**
 * `case` and `fixture` are common PascalCase/camelCase parts of real class
 * names (`BadgeCase`, `UseCase`, `TestFixture`). They are still a leak when they
 * form a whole component or a kebab/snake/dot-delimited token (`case/`,
 * `eval-case.md`, `Fixture.kt`, `test-fixture.kt`).
 */
const PUNCTUATION_ONLY_TERMS = new Set(["case", "fixture"]);

/**
 * Markers that admit a defect in staged text. Every marker is token-aware, so
 * `DEBUG:` never matches `BUG:`. `BUG:`, `TODO:`, and `FIXME` match in any
 * case. Bare `TODO` and `XXX` match uppercase only, because lowercase "todo"
 * and "xxx" are ordinary words that a real fixture (a todo-list app) contains.
 */
const CONTENT_MARKERS: readonly { readonly marker: string; readonly pattern: RegExp }[] = [
  { marker: "BUG:", pattern: /(?<![\p{L}\p{N}_])bug:/iu },
  { marker: "FIXME", pattern: /(?<![\p{L}\p{N}_])fixme(?![\p{L}\p{N}_])/iu },
  { marker: "XXX", pattern: /(?<![\p{L}\p{N}_])XXX(?![\p{L}\p{N}_])/u },
  { marker: "TODO", pattern: /(?<![\p{L}\p{N}_])TODO(?![\p{L}\p{N}_])/u },
  { marker: "TODO:", pattern: /(?<![\p{L}\p{N}_])todo:/iu },
];

const LONGEST_MARKER_UNITS = Math.max(...CONTENT_MARKERS.map(({ marker }) => marker.length));
/** Marker plus up to two UTF-16 units of lookbehind context (one astral character). */
const SCANNER_CARRY_UNITS = LONGEST_MARKER_UNITS + 2;

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function pathComponents(relativePath: string): string[] {
  return toPosix(relativePath)
    .split("/")
    .filter((component) => component !== "" && component !== ".");
}

function splitCamelCase(value: string): string[] {
  return value
    .split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u)
    .flatMap((part) => part.split(/(?<=\p{Lu})(?=\p{Lu}[\p{Ll}])/u))
    .filter(Boolean);
}

function punctuationTokens(component: string): string[] {
  return component.split(/[-_.]+/u).filter(Boolean);
}

function deniedTermInComponent(component: string): string | undefined {
  const punct = punctuationTokens(component);
  for (const token of punct) {
    const term = token.toLowerCase();
    if (PATH_DENYLIST.has(term)) return term;
  }
  for (const piece of punct) {
    for (const camel of splitCamelCase(piece)) {
      const term = camel.toLowerCase();
      if (PATH_DENYLIST.has(term) && !PUNCTUATION_ONLY_TERMS.has(term)) return term;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (glob[index] === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += 2;
      continue;
    }
    if (glob[index] === "*") {
      pattern += "[^/]*";
      index += 1;
      continue;
    }
    if (glob[index] === "?") {
      pattern += "[^/]";
      index += 1;
      continue;
    }
    pattern += escapeRegExp(glob[index] ?? "");
    index += 1;
  }
  return new RegExp(`^${pattern}$`, "u");
}

export function deniedPathTerm(relativePath: string): string | undefined {
  for (const component of pathComponents(relativePath)) {
    const term = deniedTermInComponent(component);
    if (term !== undefined) return term;
  }
  return undefined;
}

export function deniedContentMarker(content: string): string | undefined {
  for (const { marker, pattern } of CONTENT_MARKERS) {
    if (pattern.test(content)) return marker;
  }
  return undefined;
}

export interface FixtureContentScanner {
  /** Scans the next chunk and returns the first marker found, if any. */
  push(chunk: Buffer): string | undefined;
  /** Flushes the decoder and returns a marker that ends the content, if any. */
  end(): string | undefined;
}

/**
 * Streams UTF-8 content through the marker rules with bounded memory. The
 * scanner keeps only the last few characters of the previous chunk, enough to
 * see a marker split across chunks together with the character before it. A
 * match that touches the end of a chunk waits for the next one, because the
 * character after it decides whether it is a whole token.
 */
export function createFixtureContentScanner(): FixtureContentScanner {
  const decoder = new StringDecoder("utf8");
  const patterns = CONTENT_MARKERS.map(({ marker, pattern }) => ({
    marker,
    pattern: new RegExp(pattern.source, `${pattern.flags}g`),
  }));
  let carry = "";

  const scan = (text: string, final: boolean): string | undefined => {
    const window = carry + text;
    for (const { marker, pattern } of patterns) {
      pattern.lastIndex = Math.max(0, carry.length - LONGEST_MARKER_UNITS);
      for (let match = pattern.exec(window); match !== null; match = pattern.exec(window)) {
        const end = match.index + match[0].length;
        // Matches that end inside the carry were already decided in the previous window.
        if (end < carry.length) continue;
        if (end === window.length && !final) continue;
        return marker;
      }
    }
    carry = window.slice(-SCANNER_CARRY_UNITS);
    return undefined;
  };

  return {
    push: (chunk) => scan(decoder.write(chunk), false),
    end: () => scan(decoder.end(), true),
  };
}

export function fixtureNameIsAllowed(
  relativePath: string,
  allowFixtureNameGlobs: readonly string[],
): boolean {
  if (allowFixtureNameGlobs.length === 0) return false;
  const posix = toPosix(relativePath);
  const basename = posix.split("/").pop() ?? posix;
  const candidates = new Set([posix, basename]);
  for (const glob of allowFixtureNameGlobs) {
    const matcher = globToRegExp(toPosix(glob));
    for (const candidate of candidates) {
      if (matcher.test(candidate)) return true;
    }
  }
  return false;
}

function fixtureLeakError(
  kind: "path" | "staged path" | "content",
  cue: string,
  relativePath: string,
): Error {
  return new Error(
    `[EVAL_FIXTURE_LEAK] Fixture ${kind} leaks a grading cue "${cue}": ${relativePath}`,
  );
}

/**
 * Checks both the `files[]` source path and the actor-visible staged path
 * (relative to `fixtures/`). The source check is the stricter one today, because
 * the staged path is always a suffix of it, but checking the staged path too
 * keeps the gate tied to what the actor can see. An allow glob waives a path
 * when it matches the source path, the staged path, or the basename.
 */
export function assertFixturePathDoesNotLeak(
  sourcePath: string,
  stagedPath: string,
  allowFixtureNameGlobs: readonly string[] = [],
): void {
  const waived = (): boolean =>
    fixtureNameIsAllowed(sourcePath, allowFixtureNameGlobs) ||
    fixtureNameIsAllowed(stagedPath, allowFixtureNameGlobs);
  const sourceTerm = deniedPathTerm(sourcePath);
  if (sourceTerm !== undefined && !waived()) {
    throw fixtureLeakError("path", sourceTerm, sourcePath);
  }
  const stagedTerm = deniedPathTerm(stagedPath);
  if (stagedTerm !== undefined && !waived()) {
    throw fixtureLeakError(
      "staged path",
      stagedTerm,
      `${EVAL_FIXTURES_DIR_NAME}/${toPosix(stagedPath)} (from ${sourcePath})`,
    );
  }
}

export function fixtureContentLeakError(relativePath: string, marker: string): Error {
  return fixtureLeakError("content", marker, relativePath);
}

export function assertFixtureContentDoesNotLeak(relativePath: string, content: string): void {
  const marker = deniedContentMarker(content);
  if (marker === undefined) return;
  throw fixtureContentLeakError(relativePath, marker);
}
