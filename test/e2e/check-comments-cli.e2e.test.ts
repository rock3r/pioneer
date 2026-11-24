import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createEvalWorkspace,
  nativeEvalSandboxAvailable,
  PIONEER_CLI,
  runPioneer,
} from "./support/harness.js";
import { writeScriptedPi } from "./support/scripted-pi.js";

const DIFF = [
  "diff --git a/work.ts b/work.ts",
  "--- a/work.ts",
  "+++ b/work.ts",
  "@@ -1 +1,2 @@",
  "+// TODO implement retry",
  " start();",
  "",
].join("\n");

const PROVIDER_STUB = `
let attempts = 0;
globalThis.fetch = async (url, request) => {
  const clef = process.env.FIXTURE_PROVIDER === "cloudflare";
  const expected = clef
    ? "https://api.cloudflare.com/client/v4/accounts/" + process.env.CLOUDFLARE_ACCOUNT_ID + "/ai/run/@cf/cloudflare/clef"
    : "https://api.typesafe.ai/v1/systemone";
  const payload = JSON.parse(request.body);
  if (url !== expected || request.method !== "POST" ||
      payload.model !== (clef ? "clef" : "jev-latest") ||
      request.headers.authorization !== "Bearer stub-decision-key") {
    throw new Error("Unexpected fixture request");
  }
  attempts++;
  if (process.env.FIXTURE_TRANSIENT === "always" ||
      (process.env.FIXTURE_TRANSIENT === "once" && attempts === 1)) {
    return new Response(null, {status: 503});
  }
  const answers = {
    excuse_skipped_ask: {type: "noul", noul: 0},
    dismissed_edge_case: {type: "noul", noul: 0},
    in_scope_todo: {type: "noul", noul: 0.9},
  };
  return Response.json(clef ? {success: true, result: {answers}} : {answers});
};
`;

function runCli(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(PROVIDER_STUB)}`, PIONEER_CLI, ...args],
    {
      encoding: "utf8",
      input: DIFF,
      env: { SystemRoot: process.env.SystemRoot, ...environment },
      timeout: 5_000,
    },
  );
}

describe("check-comments CLI entry point", () => {
  it.runIf(process.platform === "win32")("reports Pi scoring as unavailable on Windows", () => {
    const result = runCli([
      "check-comments",
      "--diff-file",
      "-",
      "--scope",
      "Implement retry",
      "--provider",
      "pi",
      "--model",
      "openrouter/fixture",
      "--json",
    ]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: false,
      scored: 0,
      failures: [{ message: expect.stringMatching(/Windows|macOS.*Linux/i) }],
    });
  });
  it("advertises the subcommand in main help and prints focused help", () => {
    expect(runCli(["--help"]).stdout).toContain("pioneer check-comments");
    const result = runCli(["check-comments", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--max-comments N");
  });

  it.each(["typesafe", "cloudflare"])(
    "reports recovered and incomplete scores with %s",
    (provider) => {
      const args = [
        "check-comments",
        "--diff-file",
        "-",
        "--scope",
        "Implement retry",
        "--provider",
        provider,
        "--json",
        "--fail-on-findings",
      ];
      const environment =
        provider === "cloudflare"
          ? {
              CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
              CLOUDFLARE_API_TOKEN: "stub-decision-key",
            }
          : { TYPESAFE_API_KEY: "stub-decision-key" };
      const findings = runCli(args, {
        ...environment,
        FIXTURE_PROVIDER: provider,
        FIXTURE_TRANSIENT: "once",
      });
      expect(findings.status).toBe(2);
      expect(JSON.parse(findings.stdout)).toMatchObject({
        complete: true,
        findings: [{ category: "in_scope_todo", path: "work.ts", startLine: 1 }],
      });
      const incomplete = runCli(args, {
        ...environment,
        FIXTURE_PROVIDER: provider,
        FIXTURE_TRANSIENT: "always",
      });
      expect(incomplete.status).toBe(3);
      expect(JSON.parse(incomplete.stdout)).toMatchObject({
        complete: false,
        scored: 0,
        findings: [],
        failures: [{ message: expect.stringContaining("503") }],
      });
      const missing = runCli(args);
      expect(missing.status).toBe(3);
      expect(JSON.parse(missing.stdout).failures[0].message).toContain(
        provider === "cloudflare" ? "CLOUDFLARE_API_TOKEN" : "TYPESAFE_API_KEY",
      );
    },
  );
});

const sandboxReady = await nativeEvalSandboxAvailable();

it.skipIf(!sandboxReady)(
  "classifies the diff with a tool-free Pi isolated from the source",
  async () => {
    const ws = await createEvalWorkspace("pi-comment");
    try {
      const diff = path.join(ws.root, "unshared.diff");
      await writeFile(diff, DIFF);
      await writeFile(path.join(ws.piHome, "AGENTS.md"), "Private agent instructions");
      const skill = path.join(ws.piHome, "skills", "private-skill");
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), "Private skill instructions");
      await writeScriptedPi(ws, {
        version: "1.6.0",
        models: ["openrouter/fixture"],
        actor: { kind: "classify-comment", deniedPath: diff },
      });
      const result = await runPioneer(
        { ...ws, environment: { ...ws.environment, PI_CODING_AGENT_DIR: ws.piHome } },
        [
          "check-comments",
          "--diff-file",
          diff,
          "--scope",
          "Implement retry",
          "--provider",
          "pi",
          "--model",
          "openrouter/fixture",
          "--json",
          "--fail-on-findings",
        ],
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: true,
        scored: 1,
        findings: [{ path: "work.ts", startLine: 1, category: "in_scope_todo" }],
      });
    } finally {
      await ws.remove();
    }
  },
);

it.skipIf(!sandboxReady).each(["SIGINT", "SIGTERM"] as const)(
  "stops the Pi batch and cleans up the active actor on %s",
  async (signal) => {
    const ws = await createEvalWorkspace("pi-comment-interrupt");
    try {
      const diff = path.join(ws.root, "unshared.diff");
      const launches = path.join(ws.root, "launches.jsonl");
      const intercept = path.join(ws.root, "interrupt-on-agent-start.mjs");
      await writeFile(
        diff,
        [
          "diff --git a/work.ts b/work.ts",
          "--- a/work.ts",
          "+++ b/work.ts",
          "@@ -1,3 +1,6 @@",
          "+// TODO implement retry",
          " start();",
          "+// TODO wait for interruption",
          " work();",
          "+// TODO finish cleanup",
          " finish();",
          "",
        ].join("\n"),
      );
      await writeScriptedPi(ws, {
        version: "1.6.0",
        models: ["openrouter/fixture"],
        actor: {
          kind: "classify-comment",
          deniedPath: diff,
          hangOnComment: "wait for interruption",
        },
      });
      // Observe controller spawns and send the signal only once the second actor has its prompt.
      await writeFile(
        intercept,
        `import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
const spawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
  const child = spawn(file, args, options);
  if (args?.includes('rpc')) {
    appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ pid: child.pid, agentDir: options.env.PI_CODING_AGENT_DIR }) + '\\n');
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (JSON.parse(line).type === 'agent_start') process.kill(process.pid, ${JSON.stringify(signal)});
    });
  }
  return child;
};
syncBuiltinESMExports();\n`,
      );
      const result = await runPioneer(
        {
          ...ws,
          environment: {
            ...ws.environment,
            PI_CODING_AGENT_DIR: ws.piHome,
            NODE_OPTIONS: `--import=${pathToFileURL(intercept).href}`,
          },
        },
        [
          "check-comments",
          "--diff-file",
          diff,
          "--scope",
          "Implement retry",
          "--provider",
          "pi",
          "--model",
          "openrouter/fixture",
          "--json",
        ],
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(3);
      const actors = (await readFile(launches, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; agentDir: string });
      expect(actors).toHaveLength(2);
      for (const { pid, agentDir } of actors) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        await expect(access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: false,
        extracted: 3,
        scored: 1,
        omitted: 0,
        findings: [{ startLine: 1 }],
        failures: [{ message: `[COMMENT_PI_INTERRUPTED] Pi scoring stopped on ${signal}.` }],
      });
    } finally {
      await ws.remove();
    }
  },
);
