import { describe, expect, it } from "vitest";
import {
  assertFixtureContentDoesNotLeak,
  assertFixturePathDoesNotLeak,
  createFixtureContentScanner,
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
    ["TestFixture.kt"],
    ["evals/files/FixtureLoader.kt"],
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
    ["Fixture.kt", "fixture"],
    ["test-fixture.kt", "fixture"],
    ["samples/fixture/parser.ts", "fixture"],
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

  it("does not treat DEBUG: as a BUG: grading marker", () => {
    expect(deniedContentMarker("DEBUG: request failed")).toBeUndefined();
    expect(deniedContentMarker("log DEBUG: still a level name")).toBeUndefined();
    expect(deniedContentMarker("BUG: off-by-one")).toBe("BUG:");
    expect(deniedContentMarker("// BUG: off-by-one")).toBe("BUG:");
  });

  it.each([
    ["// BUG: off-by-one", "BUG:"],
    ["FIXME: restore the previous duration", "FIXME"],
    ["hex dump then XXX leftover", "XXX"],
    ["// TODO remove this hint", "TODO"],
  ])("rejects marker in %j", (content, marker) => {
    expect(deniedContentMarker(content)).toBe(marker);
  });

  it.each([
    ["// bug: off-by-one", "BUG:"],
    ["// Bug: off-by-one", "BUG:"],
    ["// todo: remove this hint", "TODO:"],
    ["# ToDo: remove this hint", "TODO:"],
    ["fixme restore the previous duration", "FIXME"],
    ["// Fixme: restore", "FIXME"],
  ])("rejects the colon form or FIXME in any case in %j", (content, marker) => {
    expect(deniedContentMarker(content)).toBe(marker);
  });

  it.each([
    ["a todo list app\n"],
    ["Add a todo to the list\n"],
    ["const xxx = 1\n"],
    ["debug: request failed\n"],
    ["Debug: request failed\n"],
    ["const todoItem = 1\n"],
    ["prefixme and fixmeLater\n"],
  ])("keeps bare lowercase todo, xxx, and debug: legal in %j", (content) => {
    expect(deniedContentMarker(content)).toBeUndefined();
  });
});

describe("createFixtureContentScanner", () => {
  function scan(chunks: readonly string[]): string | undefined {
    const scanner = createFixtureContentScanner();
    for (const chunk of chunks) {
      const marker = scanner.push(Buffer.from(chunk, "utf8"));
      if (marker !== undefined) return marker;
    }
    return scanner.end();
  }

  it("finds a marker split across chunks", () => {
    expect(scan(["let a = 1 // TO", "DO remove\n"])).toBe("TODO");
    expect(scan(["// FI", "X", "ME later"])).toBe("FIXME");
    expect(scan(["// bug", ": off-by-one"])).toBe("BUG:");
  });

  it("does not flag a marker cut short by the chunk boundary", () => {
    expect(scan(["const TODO", "S = 1\n"])).toBeUndefined();
    expect(scan(["xTODO", "\n"])).toBeUndefined();
    expect(scan(["de", "bug: request failed"])).toBeUndefined();
  });

  it("flags a marker at the very end of the final chunk", () => {
    expect(scan(["tail ", "TODO"])).toBe("TODO");
  });

  it("keeps the lookbehind across a chunk that ends inside a multi-byte character", () => {
    const text = Buffer.from("\u00e9TODO", "utf8");
    const scanner = createFixtureContentScanner();
    expect(scanner.push(text.subarray(0, 1))).toBeUndefined();
    expect(scanner.push(text.subarray(1))).toBeUndefined();
    expect(scanner.end()).toBeUndefined();
  });

  it("does not grow its carry with the input", () => {
    const scanner = createFixtureContentScanner();
    for (let index = 0; index < 1_000; index += 1) {
      expect(scanner.push(Buffer.from("x".repeat(4_096)))).toBeUndefined();
    }
    expect(scanner.end()).toBeUndefined();
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
    expect(() =>
      assertFixturePathDoesNotLeak("evals/files/MOTION-stale.md", "MOTION-stale.md"),
    ).toThrow(/\[EVAL_FIXTURE_LEAK\].*stale.*MOTION-stale\.md/);
  });

  it("is silent when a repeatable allow glob covers the path", () => {
    expect(() =>
      assertFixturePathDoesNotLeak("evals/files/MOTION-stale.md", "MOTION-stale.md", [
        "MOTION-stale.md",
      ]),
    ).not.toThrow();
  });

  it("keeps rejecting a source path the actor never sees", () => {
    expect(() => assertFixturePathDoesNotLeak("samples/fixture/parser.ts", "parser.ts")).toThrow(
      /\[EVAL_FIXTURE_LEAK\].*fixture.*samples\/fixture\/parser\.ts/,
    );
  });

  it("also checks the actor-visible staged path", () => {
    expect(() => assertFixturePathDoesNotLeak("evals/files/parser.ts", "stale/parser.ts")).toThrow(
      /\[EVAL_FIXTURE_LEAK\] Fixture staged path.*stale.*fixtures\/stale\/parser\.ts/,
    );
  });

  it("lets an allow glob that names the staged path waive it", () => {
    expect(() =>
      assertFixturePathDoesNotLeak("evals/files/parser.ts", "stale/parser.ts", ["stale/*"]),
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
