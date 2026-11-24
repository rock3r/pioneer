import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCase, corpusCases, parseOptions, summarize } from "./check-comments.mjs";

const { cases } = corpusCases();
const positive = cases.find((entry) => entry.expectedCategories.length !== 0);
const control = cases.find((entry) => entry.expectedCategories.length === 0);
assert.ok(positive);
assert.ok(control);

function observation(status, overrides) {
  return {
    status,
    stdout: JSON.stringify({
      complete: true,
      threshold: 0.8,
      extracted: 1,
      scored: 1,
      omitted: 0,
      failures: [],
      findings: [],
      ...overrides,
    }),
  };
}

test("requires an explicit live provider and supports native and custom profiles", () => {
  assert.equal(parseOptions([]).live, false);
  assert.throws(() => parseOptions(["--provider", "typesafe"]), /--live/);
  assert.throws(() => parseOptions(["--live"]), /--provider/);
  assert.equal(parseOptions(["--live", "--provider", "gemini"]).model, "gemini-decision-1");
  assert.throws(() => parseOptions(["--live", "--provider", "custom"]), /--endpoint/);
  const custom = parseOptions([
    "--live",
    "--provider",
    "custom",
    "--endpoint",
    "https://example.invalid/v1/systemone",
    "--model",
    "fallback/model",
    "--api-key-env",
    "CUSTOM_API_KEY",
  ]);
  assert.equal(custom.model, "fallback/model");
  assert.equal(custom.apiKeyEnv, "CUSTOM_API_KEY");
});

test("requires a qualified model and rejects direct credentials and endpoints in a Pi eval", () => {
  const prefix = ["--live", "--provider", "pi"];
  assert.throws(() => parseOptions(prefix), /qualified --model/);
  assert.throws(() => parseOptions([...prefix, "--model", "bare-model"]), /qualified --model/);
  assert.throws(() => parseOptions([...prefix, "--model", "provider//model"]), /qualified --model/);
  const model = [...prefix, "--model", "openrouter/vendor/id"];
  assert.equal(parseOptions(model).model, "openrouter/vendor/id");
  assert.throws(
    () => parseOptions([...model, "--endpoint", "https://example.invalid"]),
    /--endpoint/,
  );
  assert.throws(() => parseOptions([...model, "--api-key-env", "EVAL_KEY"]), /--api-key-env/);
});

test("labels a scored zero-finding control as correct", () => {
  const row = assessCase(control, observation(0, {}), 0.8);
  assert.equal(row.status, "match");
  assert.equal(row.scored, 1);
  assert.equal(row.expectedExitCode, 0);
});

test("labels exactly the requested category at the requested location", () => {
  const row = assessCase(
    positive,
    observation(2, {
      findings: [
        {
          path: positive.path,
          startLine: positive.commentLine,
          endLine: positive.commentLine,
          category: positive.expectedCategories[0],
          probability: 0.8,
        },
      ],
    }),
    0.8,
  );
  assert.equal(row.status, "match");
  assert.equal(row.expectedExitCode, 2);
});

test("keeps empty extraction and incomplete scoring out of semantic accuracy", () => {
  const empty = assessCase(control, observation(0, { extracted: 0, scored: 0 }), 0.8);
  const incomplete = assessCase(
    control,
    observation(3, {
      complete: false,
      scored: 0,
      failures: [{ message: "[COMMENT_PROVIDER_HTTP] HTTP 429. artificial-key" }],
    }),
    0.8,
  );
  assert.equal(empty.status, "incomplete");
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(incomplete.failureCodes, ["COMMENT_PROVIDER_HTTP"]);
  assert.deepEqual(incomplete.httpStatuses, [429]);
  assert.doesNotMatch(JSON.stringify(incomplete), /artificial-key/);
  assert.equal(summarize([empty, incomplete]).semantics.evaluatedCases, 0);
});

test("reports absent and unexpected categories only for fully scored cases", () => {
  const miss = assessCase(positive, observation(0, {}), 0.8);
  const unexpected = assessCase(
    control,
    observation(2, {
      findings: [
        {
          path: control.path,
          startLine: control.commentLine,
          endLine: control.commentLine,
          category: positive.expectedCategories[0],
          probability: 0.9,
        },
      ],
    }),
    0.8,
  );
  assert.equal(miss.status, "mismatch");
  assert.equal(miss.expectedExitCode, 2);
  assert.deepEqual(miss.missingCategories, positive.expectedCategories);
  assert.equal(unexpected.status, "mismatch");
  assert.deepEqual(unexpected.unexpectedCategories, positive.expectedCategories);
  const report = summarize([miss, unexpected]);
  assert.equal(report.coverage.scoredComments, 2);
  assert.equal(report.semantics.exactMatches, 0);
  assert.deepEqual(report.semantics.categories[positive.expectedCategories[0]], {
    truePositive: 0,
    falsePositive: 1,
    trueNegative: 0,
    falseNegative: 1,
  });
});

test("keeps one scope-matched control per positive and two pairs per category", () => {
  assert.equal(cases.length, 12);
  for (const category of ["excuse_skipped_ask", "dismissed_edge_case", "in_scope_todo"]) {
    const examples = cases.filter((entry) => entry.focus === category);
    const positives = examples.filter((entry) => entry.expectedCategories.length !== 0);
    const controls = examples.filter((entry) => entry.expectedCategories.length === 0);
    assert.equal(positives.length, 2);
    assert.equal(controls.length, 2);
    for (const expected of positives) {
      const scopedControl = controls.find((entry) => entry.diff === expected.diff);
      assert.ok(scopedControl);
      assert.notEqual(scopedControl.scope, expected.scope);
    }
  }
});
