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
 * `case` is a common PascalCase suffix (`BadgeCase`, `UseCase`). It is still a
 * leak when kebab/snake/dot-delimited (`case/`, `eval-case.md`).
 */
const PUNCTUATION_ONLY_TERMS = new Set(["case"]);

const CONTENT_MARKERS: readonly { readonly marker: string; readonly pattern: RegExp }[] = [
  { marker: "BUG:", pattern: /BUG:/ },
  { marker: "FIXME", pattern: /\bFIXME\b/ },
  { marker: "XXX", pattern: /\bXXX\b/ },
  { marker: "TODO", pattern: /\bTODO\b/ },
];

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

function fixtureLeakError(kind: "path" | "content", cue: string, relativePath: string): Error {
  const noun = kind === "path" ? "path" : "content";
  return new Error(
    `[EVAL_FIXTURE_LEAK] Fixture ${noun} leaks a grading cue "${cue}": ${relativePath}`,
  );
}

export function assertFixturePathDoesNotLeak(
  relativePath: string,
  allowFixtureNameGlobs: readonly string[] = [],
): void {
  const term = deniedPathTerm(relativePath);
  if (term === undefined) return;
  if (fixtureNameIsAllowed(relativePath, allowFixtureNameGlobs)) return;
  throw fixtureLeakError("path", term, relativePath);
}

export function assertFixtureContentDoesNotLeak(relativePath: string, content: string): void {
  const marker = deniedContentMarker(content);
  if (marker === undefined) return;
  throw fixtureLeakError("content", marker, relativePath);
}
