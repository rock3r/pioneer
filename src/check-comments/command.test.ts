import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { runCheckCommentsCli } from "./command.js";
import type { FetchDecision } from "./providers.js";

const { createTempDir } = registerManagedTempPaths();

const answers = {
  excuse_skipped_ask: { type: "noul", noul: 0.1 },
  dismissed_edge_case: { type: "noul", noul: 0.2 },
  in_scope_todo: { type: "noul", noul: 0.8 },
};
const DIFF = [
  "diff --git a/work.ts b/work.ts",
  "--- a/work.ts",
  "+++ b/work.ts",
  "@@ -1 +1,3 @@",
  "+// TODO retry",
  " const state = start();",
  "+// TODO report status",
  "",
].join("\n");

function harness(diff = DIFF, environment: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "fake-key" }) {
  const messages: string[] = [];
  const fetch = vi.fn<FetchDecision>().mockImplementation(async () => Response.json({ answers }));
  async function* stdin() {
    yield Buffer.from(diff);
  }
  return {
    fetch,
    environment,
    stdin: stdin(),
    stdout: (message: string) => messages.push(message),
    output: () => messages.join(""),
  };
}

const ARGS = ["--diff-file", "-", "--scope", "Complete retry and status reporting", "--json"];

describe("check-comments CLI", () => {
  it("reports findings from stdin and distinguishes the flag-controlled exit status", async () => {
    const input = harness();
    await expect(runCheckCommentsCli([...ARGS, "--fail-on-findings"], input)).resolves.toBe(2);
    expect(JSON.parse(input.output())).toMatchObject({
      complete: true,
      extracted: 2,
      scored: 2,
      omitted: 0,
      findings: [
        { path: "work.ts", startLine: 1, endLine: 1, category: "in_scope_todo", probability: 0.8 },
        { path: "work.ts", startLine: 3, endLine: 3, category: "in_scope_todo", probability: 0.8 },
      ],
      failures: [],
    });
    expect(input.output()).not.toContain("TODO retry");
    await expect(runCheckCommentsCli(ARGS, harness())).resolves.toBe(0);
  });

  it("uses the inclusive threshold for finding probabilities", async () => {
    const input = harness();
    await expect(
      runCheckCommentsCli([...ARGS, "--threshold", "0.81", "--fail-on-findings"], input),
    ).resolves.toBe(0);
    expect(JSON.parse(input.output())).toMatchObject({ complete: true, scored: 2, findings: [] });
  });

  it("reports partial failure with precedence over findings and redacts response content", async () => {
    const input = harness();
    input.fetch.mockResolvedValueOnce(new Response("Credential fake-key", { status: 403 }));
    const result = await runCheckCommentsCli(
      [...ARGS, "--fail-on-findings", "--concurrency", "1"],
      input,
    );
    expect(result).toBe(3);
    expect(JSON.parse(input.output())).toMatchObject({
      complete: false,
      scored: 1,
      findings: [{ path: "work.ts", startLine: 3, category: "in_scope_todo" }],
      failures: [{ path: "work.ts", startLine: 1, message: expect.stringContaining("HTTP 403") }],
    });
    expect(input.output()).not.toContain("fake-key");
  });

  it("reports a reached comment limit as incomplete and bounds calls", async () => {
    const input = harness();
    await expect(runCheckCommentsCli([...ARGS, "--max-comments", "1"], input)).resolves.toBe(3);
    expect(input.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(input.output())).toMatchObject({
      complete: false,
      extracted: 2,
      scored: 1,
      omitted: 1,
    });
  });

  it("fails credential preflight before reading stdin or using the provider", async () => {
    const input = harness(DIFF, {});
    const stdin = {
      [Symbol.asyncIterator]: vi.fn(input.stdin[Symbol.asyncIterator].bind(input.stdin)),
    };
    await expect(runCheckCommentsCli(ARGS, { ...input, stdin })).resolves.toBe(3);
    expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled();
    expect(input.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(input.output())).toMatchObject({
      complete: false,
      failures: [{ message: expect.stringContaining("TYPESAFE_API_KEY") }],
    });
  });

  it("reads files and reports malformed patches before contacting the provider", async () => {
    const temp = await createTempDir("comment-check");
    const scope = path.join(temp, "scope.md");
    const diff = path.join(temp, "changes.diff");
    const input = harness();
    await Promise.all([writeFile(scope, "Complete retry"), writeFile(diff, "not a patch")]);
    await expect(
      runCheckCommentsCli(["--diff-file", diff, "--scope-file", scope, "--json"], input),
    ).resolves.toBe(3);
    expect(JSON.parse(input.output())).toMatchObject({
      failures: [{ message: expect.stringContaining("COMMENT_DIFF_INVALID") }],
    });
    expect(input.fetch).not.toHaveBeenCalled();
  });

  it("rejects contradictory inputs and invalid bounds", async () => {
    const input = harness();
    await expect(
      runCheckCommentsCli([...ARGS, "--source", ".", "--git", "staged"], input),
    ).rejects.toThrow(/choose either/i);
    await expect(runCheckCommentsCli([...ARGS, "--concurrency", "0"], input)).rejects.toThrow(
      /--concurrency/,
    );
    await expect(runCheckCommentsCli([...ARGS, "--threshold", "Infinity"], input)).rejects.toThrow(
      /--threshold/,
    );
    expect(input.fetch).not.toHaveBeenCalled();
  });

  it("prints command help before credential validation", async () => {
    const input = harness("", {});
    await expect(runCheckCommentsCli(["--help"], input)).resolves.toBe(0);
    expect(input.output()).toContain("pioneer check-comments");
  });

  it("collects a staged Git patch using the same scanner as file inputs", async () => {
    const temp = await createTempDir("comment-git");
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    };
    execFileSync("git", ["init", "--quiet"], { cwd: temp, env });
    await writeFile(path.join(temp, "work.ts"), "// TODO implement retry\n");
    execFileSync("git", ["add", "--", "work.ts"], { cwd: temp, env });
    const input = harness();
    const result = await runCheckCommentsCli(
      [
        "--source",
        temp,
        "--git",
        "staged",
        "working-tree",
        "--scope",
        "Implement retry",
        "--json",
        "--fail-on-findings",
      ],
      input,
    );
    expect(result).toBe(2);
    expect(JSON.parse(input.output())).toMatchObject({
      complete: true,
      extracted: 1,
      scored: 1,
      findings: [{ path: "work.ts", startLine: 1 }],
    });
  });
});
