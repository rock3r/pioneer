import { describe, expect, it } from "vitest";
import {
  assertFixtureContentDoesNotLeak,
  assertFixturePathDoesNotLeak,
  deniedContentMarker,
  deniedPathTerm,
  fixtureNameIsAllowed,
} from "./fixture-leak.js";

describe("deniedPathTerm word-boundary matching", () => {
  it.each([
    ["BadgeCase.kt"],
    ["GoodsList.kt"],
    ["BugsnagClient.kt"],
    ["evals/files/BadgeCase.kt"],
    ["evals/files/parser.ts"],
    ["evals/files/CONFIG.md"],
    ["panel/Screen.kt"],
  ])("allows %s", (relativePath) => {
    expect(deniedPathTerm(relativePath)).toBeUndefined();
  });

  it.each([
    ["evals/files/MOTION-stale.md", "stale"],
    ["rough-tier/Screen.kt", "rough"],
    ["evals/files/broken-selector.kt", "broken"],
    ["evals/files/staleMotion.md", "stale"],
    ["good.kt", "good"],
    ["evals/files/expected.md", "expected"],
    ["showcase/Screen.kt", "showcase"],
    ["case/input.md", "case"],
    ["fixture.txt", "fixture"],
  ])("rejects %s for %s", (relativePath, term) => {
    expect(deniedPathTerm(relativePath)).toBe(term);
  });
});

describe("deniedContentMarker", () => {
  it("allows ordinary source that does not admit a defect", () => {
    expect(deniedContentMarker("fun render() = 42\n")).toBeUndefined();
    expect(deniedContentMarker("const todos = listOf(1)\n")).toBeUndefined();
    expect(deniedContentMarker('val prefix = "BUG"\n')).toBeUndefined();
  });

  it.each([
    ["// BUG: off-by-one", "BUG:"],
    ["FIXME: restore the previous duration", "FIXME"],
    ["hex dump then XXX leftover", "XXX"],
    ["// TODO remove this hint", "TODO"],
  ])("rejects marker in %j", (content, marker) => {
    expect(deniedContentMarker(content)).toBe(marker);
  });
});

describe("fixtureNameIsAllowed", () => {
  it("matches a basename glob against a nested files[] path", () => {
    expect(fixtureNameIsAllowed("evals/files/MOTION-stale.md", ["MOTION-stale.md"])).toBe(true);
  });

  it("matches a ** glob against an intermediate directory", () => {
    expect(fixtureNameIsAllowed("evals/files/rough-tier/Screen.kt", ["**/rough-tier/**"])).toBe(
      true,
    );
  });

  it("does not treat an unrelated glob as an allow", () => {
    expect(fixtureNameIsAllowed("evals/files/MOTION-stale.md", ["good.kt"])).toBe(false);
  });
});

describe("assertFixturePathDoesNotLeak", () => {
  it("throws [EVAL_FIXTURE_LEAK] for a leaking path", () => {
    expect(() => assertFixturePathDoesNotLeak("evals/files/MOTION-stale.md")).toThrow(
      /\[EVAL_FIXTURE_LEAK\].*stale.*MOTION-stale\.md/,
    );
  });

  it("is silent when a repeatable allow glob covers the path", () => {
    expect(() =>
      assertFixturePathDoesNotLeak("evals/files/MOTION-stale.md", ["MOTION-stale.md"]),
    ).not.toThrow();
  });
});

describe("assertFixtureContentDoesNotLeak", () => {
  it("throws [EVAL_FIXTURE_LEAK] for a content marker", () => {
    expect(() =>
      assertFixtureContentDoesNotLeak("evals/files/parser.ts", "// TODO hint\n"),
    ).toThrow(/\[EVAL_FIXTURE_LEAK\].*TODO.*parser\.ts/);
  });

  it("does not honor the name allow hatch for content markers", () => {
    expect(() =>
      assertFixtureContentDoesNotLeak("evals/files/parser.ts", "FIXME leftover\n"),
    ).toThrow(/\[EVAL_FIXTURE_LEAK\].*FIXME/);
  });
});
