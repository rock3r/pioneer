import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PIONEER_CLI } from "./support/harness.js";

const DIFF = [
  "diff --git a/work.ts b/work.ts",
  "--- a/work.ts",
  "+++ b/work.ts",
  "@@ -1 +1,2 @@",
  "+// TODO implement retry",
  " start();",
  "",
].join("\n");

const PROVIDER_STUB = [
  "globalThis.fetch = async (url, request) => {",
  "  if (url !== 'https://api.typesafe.ai/v1/systemone' || request.method !== 'POST') {",
  "    throw new Error('Unexpected request');",
  "  }",
  "  return Response.json({answers: {",
  "    excuse_skipped_ask: {type: 'noul', noul: 0},",
  "    dismissed_edge_case: {type: 'noul', noul: 0},",
  "    in_scope_todo: {type: 'noul', noul: 0.9},",
  "  }});",
  "};",
].join("\n");

function runCli(args: readonly string[], key?: string) {
  return spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(PROVIDER_STUB)}`, PIONEER_CLI, ...args],
    {
      encoding: "utf8",
      input: DIFF,
      env: { SystemRoot: process.env.SystemRoot, TYPESAFE_API_KEY: key },
      timeout: 5_000,
    },
  );
}

describe("check-comments CLI entry point", () => {
  it("advertises the subcommand in main help and prints focused help", () => {
    expect(runCli(["--help"]).stdout).toContain("pioneer check-comments");
    const result = runCli(["check-comments", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--max-comments N");
  });

  it("preserves the findings and incomplete exit codes through dispatch", () => {
    const args = [
      "check-comments",
      "--diff-file",
      "-",
      "--scope",
      "Implement retry",
      "--json",
      "--fail-on-findings",
    ];
    const findings = runCli(args, "stub-decision-key");
    expect(findings.status).toBe(2);
    expect(JSON.parse(findings.stdout)).toMatchObject({
      complete: true,
      findings: [{ category: "in_scope_todo", path: "work.ts", startLine: 1 }],
    });
    const incomplete = runCli(args);
    expect(incomplete.status).toBe(3);
    expect(JSON.parse(incomplete.stdout)).toMatchObject({
      complete: false,
      failures: [{ message: expect.stringContaining("TYPESAFE_API_KEY") }],
    });
  });
});
