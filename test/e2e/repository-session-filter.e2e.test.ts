import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computePacketDigest } from "../../src/deep-review/packet.js";
import {
  createEvalWorkspace,
  type EvalWorkspace,
  nativeEvalSandboxAvailable,
  runPioneer,
} from "./support/harness.js";

// This Pi fixture exposes different models depending on the files staged beside its extension.
// The controller and adapter run normally, but the actor does no inference or network IO.
const CLI = `
const { existsSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const argv = process.argv.slice(2);
const arg = (flag) => argv[argv.indexOf(flag) + 1];
if (argv.includes("--version")) {
  console.log("1.6.0");
  process.exit(0);
}
const entry = argv.find((value, index) =>
  argv[index - 1] === "--extension" && basename(value) === "fixture-extension.mjs");
if (!entry || !existsSync(entry)) throw new Error("Missing staged extension");
const full = existsSync(join(dirname(entry), "records.jsonl"));
if (argv.includes("--list-models")) {
  console.log("provider  model  context  max-out  thinking  images");
  for (const id of (full ? ["full", "full-other"] : ["filtered", "filtered-two", "filtered-president"])) {
    console.log("scripted  " + id + "  1K  1K  no  no");
  }
} else if (arg("--mode") === "rpc") {
  process.stdin.once("data", () => {
    if (full) throw new Error("Review did not filter the project session directory");
    const content = process.env.PIONEER_DEEP_REVIEW_CANDIDATE_STORE
      ? JSON.stringify({ schemaVersion: "pioneer-pr-review-president/v1", clusters: [] })
      : process.env.PIONEER_DEEP_REVIEW_PACKET_PATH
        ? JSON.stringify({ schemaVersion: "pioneer-pr-review-worker/v1", findings: [] })
        : "Filtered review report.";
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
    process.stdin.pause();
  });
} else {
  console.log(full ? "Full extension tree." : "Filtered extension tree.");
}
`;

const sandboxReady = await nativeEvalSandboxAvailable();
let workspace: EvalWorkspace | undefined;

afterEach(async () => {
  await workspace?.remove();
  workspace = undefined;
});

async function setup() {
  const created = await createEvalWorkspace("session-filter");
  workspace = created;
  const source = path.join(created.root, "source");
  const extension = path.join(created.root, "extension");
  const entry = path.join(extension, "fixture-extension.mjs");
  const core = path.join(created.piPackageRoot, "dist", "core");
  await mkdir(path.join(source, ".pi"), { recursive: true });
  await mkdir(extension);
  await mkdir(core, { recursive: true });
  await writeFile(path.join(source, ".pi", "settings.json"), '{"sessionDir":"../extension"}');
  await writeFile(entry, "export {};");
  await writeFile(path.join(extension, "records.jsonl"), '{"type":"fixture"}\n');
  await writeFile(
    path.join(created.piPackageRoot, "package.json"),
    '{"name":"@earendil-works/pi-coding-agent","version":"1.6.0","bin":{"pi":"bin/pi"}}',
  );
  await writeFile(
    path.join(created.binDir, "pi"),
    `#!${process.execPath}\nrequire("../dist/cli.js");\n`,
    {
      mode: 0o755,
    },
  );
  await writeFile(path.join(created.piPackageRoot, "dist", "cli.js"), CLI);
  await writeFile(
    path.join(core, "settings-manager.js"),
    "exports.SettingsManager = { inMemory() {} };",
  );
  const resource = { path: entry, enabled: true, metadata: { scope: "user" } };
  await writeFile(
    path.join(core, "package-manager.js"),
    `exports.DefaultPackageManager = class { async resolve() { return { extensions: [${JSON.stringify(resource)}] }; } };`,
  );
  await writeFile(
    path.join(core, "resource-loader.js"),
    "exports.DefaultResourceLoader = class { getExtensions() { return { extensions: [], errors: [] }; } };",
  );
  const caller = {
    ...created,
    root: source,
    environment: { ...created.environment, PI_CODING_AGENT_DIR: created.piHome },
  };
  return { created, source, caller };
}

describe.skipIf(!sandboxReady)("repository session directories", () => {
  it("filters the extension snapshot passed through the normal review CLI", async () => {
    const { created, source, caller } = await setup();
    const result = await runPioneer(caller, [
      "review",
      "--source",
      source,
      "--prompt",
      "Inspect the source directory.",
      "--model",
      "scripted/filtered",
      "--no-resume",
      "--report",
      path.join(created.root, "review.md"),
      "--work-log",
      created.workLogPath("review"),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Filtered review report.");
  });

  it("filters deep-review worker and president extension snapshots", async () => {
    const { created, source, caller } = await setup();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: source,
        encoding: "utf8",
      });
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "--quiet",
      "-m",
      "Fixture",
    );
    const headSha = git("rev-parse", "HEAD").trim();
    const packet = {
      schemaVersion: "pioneer-pr-review-packet/v1" as const,
      repository: { owner: "fixture", name: "repo" },
      pullRequest: {
        number: 1,
        url: "https://github.com/fixture/repo/pull/1",
        title: "Fixture change",
        body: "",
        baseRef: "main",
        baseSha: "a".repeat(40),
        headSha,
      },
      commits: [],
      files: [
        {
          path: "README.md",
          status: "added" as const,
          contentKind: "text" as const,
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+Fixture\n",
        },
      ],
      rules: [],
      previousFindings: [],
    };
    const packetPath = path.join(created.root, "packet.json");
    const configPath = path.join(created.root, "config.json");
    const resultPath = path.join(created.root, "result.json");
    await writeFile(
      packetPath,
      JSON.stringify({ ...packet, packetDigest: computePacketDigest(packet) }),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "pioneer-deep-review-config/v1",
        council: [
          { id: "first", model: "scripted/filtered", independenceGroup: "first" },
          { id: "second", model: "scripted/filtered-two", independenceGroup: "second" },
        ],
        president: {
          id: "president",
          model: "scripted/filtered-president",
          independenceGroup: "third",
        },
      }),
    );
    const result = await runPioneer(caller, [
      "deep-review",
      "--source",
      source,
      "--packet",
      packetPath,
      "--config",
      configPath,
      "--output",
      resultPath,
      "--work-log",
      created.workLogPath("deep-review"),
    ]);
    expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({
      status: "complete",
      president: { status: "success" },
    });
  });

  it("keeps the full extension snapshot for models, doctor and eval", async () => {
    const { created, source, caller } = await setup();
    const models = await runPioneer(caller, ["models"]);
    expect(models.exitCode, models.stderr).toBe(0);
    expect(models.stdout).toContain("full-other");
    const doctor = await runPioneer(caller, ["doctor"]);
    expect(doctor.exitCode, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ pi: { modelCount: 2 } });
    const evalRun = await runPioneer(caller, [
      "eval",
      "run",
      "--run-dir",
      source,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("eval"),
      "--",
      "pi",
      "--model",
      "scripted/full",
      "--print",
      "Inspect the fixture.",
    ]);
    expect(evalRun.exitCode, evalRun.stderr).toBe(0);
    expect(evalRun.stdout.trim()).toBe("Full extension tree.");
  });
});
