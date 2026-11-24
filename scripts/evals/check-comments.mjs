import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CORPUS_URL = new URL("./check-comments-corpus.json", import.meta.url);
const CLI = fileURLToPath(new URL("../../dist/review-cli.js", import.meta.url));
const CATEGORIES = ["excuse_skipped_ask", "dismissed_edge_case", "in_scope_todo"];
const QUALIFIED_PI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/~?[A-Za-z0-9][A-Za-z0-9._:@+-]*)+$/;
const DEFAULT_MODELS = {
  typesafe: "jev-latest",
  cloudflare: "@cf/cloudflare/clef",
  gemini: "gemini-decision-1",
};
const USAGE = `Usage:
  node scripts/evals/check-comments.mjs
  node scripts/evals/check-comments.mjs --live --provider typesafe|cloudflare|gemini|custom|pi
    [--model ID] [--threshold FLOAT] [--endpoint HTTPS_URL] [--api-key-env VAR]

The default validates the synthetic corpus against the built extractor locally.
Live mode sends only the built-in synthetic patches and scopes to the selected provider.
Pi uses your configured provider. Pass a qualified --model PROVIDER/MODEL.
Build Pioneer first with npm run build.`;

export function parseOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        live: { type: "boolean" },
        provider: { type: "string" },
        model: { type: "string" },
        threshold: { type: "string" },
        endpoint: { type: "string" },
        "api-key-env": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    throw new Error("Invalid check-comments eval arguments. Use --help for options.");
  }
  if (values.help) return { help: true };
  const { live = false, provider, model, endpoint, threshold = "0.8" } = values;
  const apiKeyEnv = values["api-key-env"];
  if (!live) {
    if (Object.keys(values).length > 0)
      throw new Error("Use --live to set a provider or scoring options.");
    return { live };
  }
  if (
    provider !== "pi" &&
    provider !== "custom" &&
    !Object.hasOwn(DEFAULT_MODELS, provider ?? "")
  ) {
    throw new Error("--live requires --provider typesafe, cloudflare, gemini, custom or pi.");
  }
  const probability = Number(threshold);
  if (!threshold.trim() || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Set --threshold to a number between 0 and 1.");
  }
  if (provider === "pi") {
    if (endpoint !== undefined || apiKeyEnv !== undefined) {
      throw new Error("Pi evals do not accept --endpoint or --api-key-env.");
    }
    if (
      model === undefined ||
      model.length > 256 ||
      model !== model.trim() ||
      !QUALIFIED_PI_MODEL.test(model)
    ) {
      throw new Error("Pi evals require a qualified --model PROVIDER/MODEL.");
    }
    return { live, provider, model, threshold: probability };
  }
  if (provider === "custom" && (!endpoint || !model || !apiKeyEnv)) {
    throw new Error("Custom live runs require --endpoint, --model and --api-key-env.");
  }
  return {
    live,
    provider,
    model: model ?? DEFAULT_MODELS[provider],
    endpoint,
    apiKeyEnv,
    threshold: probability,
  };
}

export function corpusCases() {
  const { version, pairs } = JSON.parse(readFileSync(CORPUS_URL, "utf8"));
  const cases = pairs.flatMap((pair) => {
    const oldLines = pair.lines.filter((line) => !line.startsWith("+")).length;
    const newLines = pair.lines.filter((line) => !line.startsWith("-")).length;
    const diff = [
      `diff --git a/${pair.path} b/${pair.path}`,
      `--- a/${pair.path}`,
      `+++ b/${pair.path}`,
      `@@ -1,${oldLines} +1,${newLines} @@`,
      ...pair.lines,
      "",
    ].join("\n");
    const target = pair.lines.filter((line) => !line.startsWith("-"))[pair.commentLine - 1];
    if (!target?.startsWith("+") || !CATEGORIES.includes(pair.category)) {
      throw new Error(`Invalid expected comment in corpus pair ${pair.id}.`);
    }
    return ["positive", "control"].map((kind) => ({
      id: `${pair.id}/${kind}`,
      focus: pair.category,
      path: pair.path,
      diff,
      commentLine: pair.commentLine,
      commentText: target.slice(1).trim(),
      scope: pair[kind].scope,
      rationale: pair[kind].rationale,
      expectedCategories: kind === "positive" ? [pair.category] : [],
    }));
  });
  return { version, cases };
}

function atExpectedLocation(finding, entry) {
  return (
    finding?.path === entry.path &&
    finding.startLine === entry.commentLine &&
    finding.endLine === entry.commentLine
  );
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function assessCase(entry, observation, threshold) {
  let body;
  try {
    body = JSON.parse(observation.stdout);
  } catch {
    // Raw child output may include provider diagnostics. Record only recognized failure codes.
  }
  const observed = Array.isArray(body?.findings)
    ? body.findings
        .filter(
          (finding) =>
            atExpectedLocation(finding, entry) &&
            CATEGORIES.includes(finding.category) &&
            Number.isFinite(finding.probability) &&
            finding.probability >= threshold &&
            finding.probability <= 1,
        )
        .map(({ category, probability }) => ({ category, probability }))
    : [];
  const categories = observed.map(({ category }) => category);
  const expectedExitCode = entry.expectedCategories.length > 0 ? 2 : 0;
  const valid =
    !observation.error &&
    body?.complete === true &&
    body.threshold === threshold &&
    body.extracted === 1 &&
    body.scored === 1 &&
    body.omitted === 0 &&
    Array.isArray(body.failures) &&
    body.failures.length === 0 &&
    Array.isArray(body.findings) &&
    body.findings.length === observed.length &&
    new Set(categories).size === categories.length &&
    observation.status === (categories.length > 0 ? 2 : 0);
  const row = {
    id: entry.id,
    focus: entry.focus,
    rationale: entry.rationale,
    expectedCategories: entry.expectedCategories,
    expectedExitCode,
    actualExitCode: observation.status ?? null,
    extracted: count(body?.extracted),
    scored: count(body?.scored),
    observed,
  };
  if (!valid) {
    const failures = Array.isArray(body?.failures)
      ? body.failures.flatMap((failure) => {
          const match =
            typeof failure?.message === "string"
              ? /^\[(COMMENT_[A-Z0-9_]+)\](?: HTTP ([1-5]\d\d)\.)?/.exec(failure.message)
              : null;
          return match ? [{ code: match[1], httpStatus: match[2] }] : [];
        })
      : [];
    const code = observation.error?.code === "ETIMEDOUT" ? "CLI_TIMEOUT" : "CLI_RESULT_INCOMPLETE";
    return {
      ...row,
      status: "incomplete",
      failureCodes: failures.length ? failures.map((failure) => failure.code) : [code],
      httpStatuses: failures.flatMap((failure) =>
        failure.httpStatus ? [Number(failure.httpStatus)] : [],
      ),
    };
  }
  const missingCategories = entry.expectedCategories.filter(
    (category) => !categories.includes(category),
  );
  const unexpectedCategories = categories.filter(
    (category) => !entry.expectedCategories.includes(category),
  );
  const status =
    missingCategories.length === 0 && unexpectedCategories.length === 0 ? "match" : "mismatch";
  return { ...row, status, missingCategories, unexpectedCategories };
}

export function summarize(rows) {
  const evaluated = rows.filter((row) => row.status !== "incomplete");
  const categories = Object.fromEntries(
    CATEGORIES.map((category) => {
      const counts = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
      for (const row of evaluated) {
        const expected = row.expectedCategories.includes(category);
        const observed = row.observed.some((finding) => finding.category === category);
        if (expected && observed) counts.truePositive += 1;
        else if (expected) counts.falseNegative += 1;
        else if (observed) counts.falsePositive += 1;
        else counts.trueNegative += 1;
      }
      return [category, counts];
    }),
  );
  return {
    coverage: {
      expectedCases: rows.length,
      completeCases: evaluated.length,
      expectedComments: rows.length,
      extractedComments: rows.reduce((total, row) => total + row.extracted, 0),
      scoredComments: rows.reduce((total, row) => total + row.scored, 0),
    },
    semantics: {
      evaluatedCases: evaluated.length,
      exactMatches: evaluated.filter((row) => row.status === "match").length,
      categories,
    },
  };
}

function runCase(entry, options) {
  const cliArgs = [
    "check-comments",
    "--diff-file",
    "-",
    "--scope",
    entry.scope,
    "--json",
    "--fail-on-findings",
    "--max-comments",
    "1",
    "--concurrency",
    "1",
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--threshold",
    String(options.threshold),
    ...(options.endpoint === undefined ? [] : ["--endpoint", options.endpoint]),
    ...(options.apiKeyEnv === undefined ? [] : ["--api-key-env", options.apiKeyEnv]),
  ];
  const child = spawnSync(process.execPath, [CLI, ...cliArgs], {
    input: entry.diff,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: options.provider === "pi" ? 75_000 : 30_000,
    windowsHide: true,
  });
  return assessCase(entry, child, options.threshold);
}

async function inspectBuiltCorpus(cases) {
  let extractDiffComments;
  let cliVersion;
  try {
    ({ extractDiffComments } = await import("../../dist/check-comments/extract.js"));
    ({ PIONEER_VERSION: cliVersion } = await import("../../dist/package-metadata.js"));
  } catch {
    throw new Error("Build Pioneer with npm run build before running the check-comments eval.");
  }
  for (const entry of cases) {
    const comments = extractDiffComments(entry.diff);
    if (
      comments.length !== 1 ||
      !atExpectedLocation(comments[0], entry) ||
      comments[0].text !== entry.commentText ||
      comments[0].oversized
    ) {
      throw new Error(`Unexpected extraction for synthetic case ${entry.id}.`);
    }
  }
  return cliVersion;
}

async function main(args) {
  const options = parseOptions(args);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const { version, cases } = corpusCases();
  const cliVersion = await inspectBuiltCorpus(cases);
  const metadata = { corpusVersion: version, cliVersion };
  if (!options.live) {
    process.stdout.write(
      `${JSON.stringify({ mode: "corpus-validation", ...metadata, checkedCases: cases.length }, null, 2)}\n`,
    );
    return 0;
  }

  const rows = cases.map((entry) => runCase(entry, options));
  const summary = summarize(rows);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "live",
        ...metadata,
        provider: options.provider,
        model: options.model,
        threshold: options.threshold,
        ...summary,
        cases: rows,
      },
      null,
      2,
    )}\n`,
  );
  if (summary.coverage.completeCases < cases.length) return 3;
  return summary.semantics.exactMatches === cases.length ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Check-comments eval failed."}\n`,
    );
    process.exitCode = 1;
  }
}
