import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvalWorkspace,
  type EvalWorkspace,
  nativeEvalSandboxAvailable,
  runPioneer,
} from "./support/harness.js";
import { ACTOR_INVOCATION_FILE, writeScriptedPi } from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();
const workspaces: EvalWorkspace[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.remove()));
});

async function hostListener(reply: string): Promise<number> {
  const server = net.createServer((socket) => socket.end(reply));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  return address.port;
}

async function readWorkLog(logPath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function workspace(
  name: string,
  scriptedPi = true,
): Promise<{ created: EvalWorkspace; runDir: string }> {
  const created = await createEvalWorkspace(name);
  workspaces.push(created);
  const runDir = path.join(created.root, "run");
  await mkdir(runDir);
  // Eval readiness checks the configured Pi installation even when the actor is not Pi.
  if (scriptedPi) await writeScriptedPi(created, { actor: { kind: "reply-verbatim" } });
  return { created, runDir };
}

function evalRun(created: EvalWorkspace, runDir: string, name: string): string[] {
  return [
    "eval",
    "run",
    "--run-dir",
    runDir,
    "--pi-home",
    created.piHome,
    "--work-log",
    created.workLogPath(name),
    "--timeout-ms",
    "60000",
  ];
}

// Pi's bash tool spawns its shell with stdio ["ignore", "pipe", "pipe"]. libuv opens
// /dev/null for the ignored slot, which the macOS profile used to deny (#86).
const CHILD_PROCESS_ACTOR = `
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { error: result.error?.message ?? null, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const report = {
  shell: run("/bin/sh", ["-c", "echo discarded > /dev/null && printf sh-ok"]),
  git: existsSync("/usr/bin/git") ? run("/usr/bin/git", ["--version"]) : null,
};
process.stdout.write(JSON.stringify(report));
`;

interface ChildResult {
  readonly error: string | null;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(!sandboxReady)("pioneer eval run actor runtime", () => {
  it("lets an actor spawn children with ignored stdio, use /bin/sh and run Git (#86, #87)", async () => {
    const { created, runDir } = await workspace("child-process-runtime");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "child-process-runtime"),
      "--",
      "node",
      "-e",
      CHILD_PROCESS_ACTOR,
    ]);

    expect(run.stderr).not.toContain("[EVAL_");
    expect(run.exitCode, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as {
      shell: ChildResult;
      git: ChildResult | null;
    };
    expect(report.shell).toMatchObject({ error: null, status: 0, stdout: "sh-ok" });
    if (existsSync("/usr/bin/git")) {
      // xcrun may still warn that it cannot write its cache in the shared per-user temp
      // directory, which stays ungranted; the #86/#87 failures must not recur.
      expect(report.git?.stderr).not.toMatch(/dev\/null|var\/select|developer_dir|Info\.plist/i);
      expect(report.git, report.git?.stderr).toMatchObject({ error: null, status: 0 });
      expect(report.git?.stdout).toMatch(/^git version /);
    }
  });

  it("launches an actor named by its lexical /bin path on usrmerged Linux", async () => {
    const { created, runDir } = await workspace("lexical-bin-actor");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "lexical-bin-actor"),
      "--",
      "/bin/sh",
      "-c",
      "printf lexical-bin-ok",
    ]);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe("lexical-bin-ok");
  });

  it("reaches only the allowed host loopback ports, directly and outside the proxy (#88)", async () => {
    const { created, runDir } = await workspace("allow-loopback");
    const allowedPort = await hostListener("allowed-loopback-ok");
    const deniedPort = await hostListener("denied-loopback-reached");
    const actor = `
const net = require("node:net");
const attempt = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  let bytes = "";
  const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
  socket.on("data", (chunk) => { bytes += chunk; });
  socket.on("end", () => { clearTimeout(timer); resolve(bytes); });
  socket.on("error", (error) => { clearTimeout(timer); resolve("error:" + error.code); });
});
(async () => {
  process.stdout.write(JSON.stringify({
    allowed: await attempt(${allowedPort}),
    denied: await attempt(${deniedPort}),
    noProxy: process.env.NO_PROXY ?? null,
  }));
})();
`;
    const workLogPath = created.workLogPath("allow-loopback");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "allow-loopback"),
      "--allow-loopback",
      `127.0.0.1:${allowedPort}`,
      "--",
      "node",
      "-e",
      actor,
    ]);

    // The mandatory probe still proves an unlisted loopback listener is unreachable.
    expect(run.exitCode, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { allowed: string; denied: string; noProxy: string };
    expect(report.allowed).toBe("allowed-loopback-ok");
    expect(report.denied).not.toBe("denied-loopback-reached");
    expect(report.denied).toMatch(/^error:|^timeout$/);
    expect(report.noProxy).toBe("127.0.0.1,localhost");
    const network = (await readWorkLog(workLogPath)).find(
      (record) => record.type === "stage_completed" && record.stage === "network_proxy",
    );
    expect(network?.allowedLoopback).toEqual([`127.0.0.1:${allowedPort}`]);
  });

  it("keeps every loopback port closed without --allow-loopback", async () => {
    const { created, runDir } = await workspace("no-loopback");
    const port = await hostListener("loopback-reached");
    const actor = `
const socket = require("node:net").connect({ host: "127.0.0.1", port: ${port} });
socket.on("data", () => { process.stdout.write("reached"); socket.destroy(); });
socket.on("error", (error) => process.stdout.write("error:" + error.code));
setTimeout(() => { socket.destroy(); process.stdout.write("timeout"); }, 3000).unref();
`;

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "no-loopback"),
      "--",
      "node",
      "-e",
      actor,
    ]);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).not.toContain("reached");
  });

  it("passes --env variables to the actor without logging their values (#89)", async () => {
    const { created, runDir } = await workspace("actor-env");
    const workLogPath = created.workLogPath("actor-env");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "actor-env"),
      "--env",
      "CAV_SPOOL=/unmistakable/spool-value",
      "--env",
      "MCP_ARGS=--flag=value",
      "--",
      "node",
      "-e",
      "process.stdout.write(JSON.stringify({ spool: process.env.CAV_SPOOL, args: process.env.MCP_ARGS, home: process.env.HOME }))",
    ]);

    expect(run.exitCode, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { spool: string; args: string; home: string };
    expect(report).toMatchObject({ spool: "/unmistakable/spool-value", args: "--flag=value" });
    const actorStage = (await readWorkLog(workLogPath)).find(
      (record) => record.type === "stage_started" && record.stage === "actor",
    );
    expect(actorStage?.actorEnvironmentNames).toEqual(["CAV_SPOOL", "MCP_ARGS"]);
    const raw = await readFile(workLogPath, "utf8");
    expect(raw).not.toContain("unmistakable/spool-value");
  });

  it("refuses --pi-extension when the actor is not the trusted Pi package", async () => {
    const { created, runDir } = await workspace("tool-extension-untrusted");
    const extensionDir = path.join(created.root, "mcp-adapter");
    await mkdir(extensionDir);
    await writeFile(path.join(extensionDir, "index.js"), "export default () => {};\n");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "tool-extension-untrusted"),
      "--pi-extension",
      extensionDir,
      "--",
      "node",
      "-e",
      "process.stdout.write('actor-started')",
    ]);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("PI_EXTENSION_RUNTIME_UNSUPPORTED");
    expect(run.stdout).not.toContain("actor-started");
  });

  it("keeps tools only for a --pi-extension package, not for a plain -e extension (#89)", async () => {
    const { created, runDir } = await workspace("tool-extension", false);
    await writeExtensionHostingPi(created);
    const adapterDir = path.join(created.root, "mcp-adapter");
    await mkdir(path.join(adapterDir, "dist"), { recursive: true });
    await writeFile(
      path.join(adapterDir, "package.json"),
      `${JSON.stringify({ name: "fake-mcp-adapter", pi: { extensions: ["./dist/index.js"] } })}\n`,
    );
    await writeFile(path.join(adapterDir, "dist", "index.js"), "adapter-entry-marker\n");
    const strippedDir = path.join(created.root, "stripped-extension");
    await mkdir(strippedDir);
    await writeFile(path.join(strippedDir, "tools.mjs"), "stripped-entry-marker\n");
    await writeFile(path.join(runDir, "mcp.json"), '{"mcpServers":{}}\n');

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "tool-extension"),
      "--pi-extension",
      adapterDir,
      "--env",
      "CAV_SPOOL=/spool",
      "--",
      "pi",
      "--no-extensions",
      "-e",
      path.join(strippedDir, "tools.mjs"),
      "--mcp-config",
      "mcp.json",
      "--model",
      "builtin/demo",
      "--print",
      "Say READY",
    ]);

    expect(run.stderr).not.toMatch(/PI_EXTENSION_|PI_OAUTH_/);
    expect(run.exitCode, run.stderr).toBe(0);
    const invocation = JSON.parse(
      await readFile(path.join(runDir, ACTOR_INVOCATION_FILE), "utf8"),
    ) as {
      argv: string[];
      spool: string | null;
      extensions: { path: string; tools: number; entry: string }[];
    };
    expect(invocation.spool).toBe("/spool");
    expect(invocation.argv).toEqual(expect.arrayContaining(["--mcp-config", "mcp.json"]));
    const adapter = invocation.extensions.find((entry) => entry.entry === "adapter-entry-marker\n");
    const stripped = invocation.extensions.find(
      (entry) => entry.entry === "stripped-entry-marker\n",
    );
    // The adapter loads from its read-only staged copy, never from the source directory.
    expect(adapter?.path.startsWith(adapterDir)).toBe(false);
    expect(adapter?.tools).toBe(1);
    expect(stripped?.tools).toBe(0);
  });

  it("refuses a --pi-extension that is also passed with -e", async () => {
    const { created, runDir } = await workspace("tool-extension-duplicate", false);
    await writeExtensionHostingPi(created);
    const adapterDir = path.join(created.root, "mcp-adapter");
    await mkdir(adapterDir);
    await writeFile(path.join(adapterDir, "index.js"), "adapter-entry-marker\n");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "tool-extension-duplicate"),
      "--pi-extension",
      adapterDir,
      "--",
      "pi",
      "--no-extensions",
      "-e",
      path.join(adapterDir, "index.js"),
      "--model",
      "builtin/demo",
      "--print",
      "Say READY",
    ]);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("PI_EXTENSION_TOOL_SOURCE_INVALID");
    expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "refuses output files below a folder another user could replace (#98)",
    async () => {
      const { created, runDir } = await workspace("output-shared-parent");
      const shared = path.join(created.root, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);
      try {
        const run = await runPioneer(created, [
          ...evalRun(created, runDir, "output-shared-parent"),
          "--stdout-file",
          path.join(shared, "stdout.txt"),
          "--",
          "node",
          "-e",
          "process.stdout.write('never')",
        ]);
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toMatch(
          /EVAL_OUTPUT_FILE_CREATE_FAILED.*Eval stdout file parent is writable by another user/,
        );
        expect(existsSync(path.join(shared, "stdout.txt"))).toBe(false);
      } finally {
        await chmod(shared, 0o700);
      }
    },
  );

  it("names the stream that overflows and streams large output to --stdout-file", async () => {
    const { created, runDir } = await workspace("output-files");
    // Pi's JSON mode repeats every image as base64, so one read can pass the 4 MiB bound.
    const bigStdout = [
      "node",
      "-e",
      "process.stdout.write('x'.repeat(5 * 1024 * 1024)); process.stderr.write('actor-stderr')",
    ];

    const bounded = await runPioneer(created, [
      ...evalRun(created, runDir, "output-bounded"),
      "--",
      ...bigStdout,
    ]);
    expect(bounded.exitCode).not.toBe(0);
    expect(bounded.stderr).toContain(
      "[EVAL_OUTPUT_LIMIT] Eval actor stdout exceeded the 4194304-byte limit; pass --stdout-file PATH to stream it to a file",
    );

    const insideRun = await runPioneer(created, [
      ...evalRun(created, runDir, "output-inside-run"),
      "--stdout-file",
      path.join(runDir, "stdout.txt"),
      "--",
      ...bigStdout,
    ]);
    expect(insideRun.exitCode).not.toBe(0);
    expect(insideRun.stderr).toMatch(/EVAL_OUTPUT_FILE_CREATE_FAILED.*actor-visible/);

    const stdoutFile = path.join(created.root, "actor-stdout.txt");
    const streamed = await runPioneer(created, [
      ...evalRun(created, runDir, "output-streamed"),
      "--stdout-file",
      stdoutFile,
      "--",
      ...bigStdout,
    ]);
    expect(streamed.stderr).not.toContain("[EVAL_");
    expect(streamed.exitCode, streamed.stderr).toBe(0);
    expect(streamed.stdout).toBe("");
    expect(streamed.stderr).toContain("actor-stderr");
    expect((await readFile(stdoutFile)).length).toBe(5 * 1024 * 1024);
    const log = await readWorkLog(created.workLogPath("output-streamed"));
    expect(log).toContainEqual(
      expect.objectContaining({ type: "stage_started", stage: "actor", stdoutFile: true }),
    );
  });

  it("initializes a --pi-extension only in the actor, with its --env values and run directory (#91)", async () => {
    const { created, runDir } = await workspace("tool-extension-actor-init", false);
    await writeExtensionHostingPi(created, { initializeExtensions: true });
    const { adapterDir, providerEntry, configPath } = await writeInitializingExtensions(
      created,
      runDir,
    );
    const workLogPath = created.workLogPath("tool-extension-actor-init");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "tool-extension-actor-init"),
      "--pi-extension",
      adapterDir,
      "--env",
      `TOOL_ADAPTER_TOKEN=${TOOL_ADAPTER_TOKEN}`,
      "--env",
      `TOOL_ADAPTER_CONFIG=${configPath}`,
      "--",
      "pi",
      "--no-extensions",
      "-e",
      providerEntry,
      // Resolves only if the explicit extension still took part in model discovery.
      "--model",
      "ext-provider/demo",
      "--print",
      "Say READY",
    ]);

    expect(run.stderr).not.toMatch(/PI_EXTENSION_|PI_OAUTH_/);
    expect(run.exitCode, run.stderr).toBe(0);
    const invocation = JSON.parse(
      await readFile(path.join(runDir, ACTOR_INVOCATION_FILE), "utf8"),
    ) as {
      extensions: {
        path: string;
        tools: number;
        init: { config?: string; models?: string[] } | null;
      }[];
    };
    const adapter = invocation.extensions.find((entry) => entry.init?.config !== undefined);
    const provider = invocation.extensions.find((entry) => entry.init?.models !== undefined);
    expect(adapter?.init?.config).toBe(TOOL_ADAPTER_CONFIG);
    expect(adapter?.tools).toBe(1);
    expect(provider?.tools).toBe(0);
    const records = await readWorkLog(workLogPath);
    expect(
      records.some(
        (record) => record.type === "stage_completed" && record.stage === "pi_readiness",
      ),
    ).toBe(true);
    const actorStage = records.find(
      (record) => record.type === "stage_started" && record.stage === "actor",
    );
    expect(actorStage?.actorEnvironmentNames).toEqual([
      "TOOL_ADAPTER_CONFIG",
      "TOOL_ADAPTER_TOKEN",
    ]);
    expect(actorStage?.toolExtensionCount).toBe(1);
    expect(await readFile(workLogPath, "utf8")).not.toContain(TOOL_ADAPTER_TOKEN);
  });

  it("fails the actor with PI_EXTENSION_LOAD_FAILED when a --pi-extension cannot initialize", async () => {
    const { created, runDir } = await workspace("tool-extension-actor-load-failure", false);
    await writeExtensionHostingPi(created, { initializeExtensions: true });
    const { adapterDir, configPath } = await writeInitializingExtensions(created, runDir);
    const workLogPath = created.workLogPath("tool-extension-actor-load-failure");

    const run = await runPioneer(created, [
      ...evalRun(created, runDir, "tool-extension-actor-load-failure"),
      "--pi-extension",
      adapterDir,
      // TOOL_ADAPTER_TOKEN is deliberately missing, so the adapter throws while loading.
      "--env",
      `TOOL_ADAPTER_CONFIG=${configPath}`,
      "--",
      "pi",
      "--no-extensions",
      "--model",
      "builtin/demo",
      "--print",
      "Say READY",
    ]);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("[PI_EXTENSION_LOAD_FAILED]");
    expect(run.stderr).toContain("tool-adapter/index.js");
    // Raw initialization errors stay suppressed.
    expect(run.stderr).not.toContain("is not set");
    expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
    const records = await readWorkLog(workLogPath);
    expect(
      records.some(
        (record) => record.type === "stage_completed" && record.stage === "pi_readiness",
      ),
    ).toBe(true);
    expect(
      records.some((record) => record.type === "stage_started" && record.stage === "actor"),
    ).toBe(true);
  });
});

const TOOL_ADAPTER_TOKEN = "unmistakable-tool-adapter-token";
const TOOL_ADAPTER_CONFIG = '{"server":"run-directory-config"}\n';

/**
 * A `--pi-extension` package that, like an MCP adapter, needs a `--env` value and a file in
 * the run directory while it initializes, plus a plain explicit extension that registers a
 * model provider. Both are CommonJS, so the scripted resource loader can run them.
 */
async function writeInitializingExtensions(
  created: EvalWorkspace,
  runDir: string,
): Promise<{ adapterDir: string; providerEntry: string; configPath: string }> {
  const adapterDir = path.join(created.root, "tool-adapter");
  await mkdir(adapterDir);
  await writeFile(
    path.join(adapterDir, "package.json"),
    `${JSON.stringify({ name: "fake-tool-adapter", pi: { extensions: ["./index.js"] } })}\n`,
  );
  await writeFile(
    path.join(adapterDir, "index.js"),
    `const fs = require("node:fs");
module.exports = () => {
  if (!process.env.TOOL_ADAPTER_TOKEN) throw new Error("TOOL_ADAPTER_TOKEN is not set");
  return { config: fs.readFileSync(process.env.TOOL_ADAPTER_CONFIG, "utf8") };
};
`,
  );
  const providerDir = path.join(created.root, "model-provider");
  await mkdir(providerDir);
  const providerEntry = path.join(providerDir, "provider.cjs");
  await writeFile(providerEntry, 'module.exports = () => ({ models: ["ext-provider/demo"] });\n');
  const configPath = path.join(runDir, "tool-adapter.json");
  await writeFile(configPath, TOOL_ADAPTER_CONFIG);
  return { adapterDir, providerEntry, configPath };
}

interface ExtensionHostingPiOptions {
  /**
   * Run each extension's CommonJS entry while loading, like Pi does for both model
   * discovery and the actor. `--list-models` then also lists the models an extension
   * returns, and a throwing entry becomes a load error.
   */
  readonly initializeExtensions?: boolean;
}

/**
 * A trusted Pi package that can host Pioneer's extension adapter. Its resource loader
 * reports every `--extension` it was given, resolving a directory to its package entry the
 * way Pi does, with one tool each; the adapter decides which tools survive.
 */
async function writeExtensionHostingPi(
  created: EvalWorkspace,
  options: ExtensionHostingPiOptions = {},
): Promise<void> {
  const initialize = options.initializeExtensions === true;
  const root = created.piPackageRoot;
  const cliPath = path.join(root, "dist", "cli.js");
  await mkdir(path.join(root, "dist", "core"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.2",
      type: "module",
      bin: { pi: "dist/cli.js" },
    })}\n`,
  );
  await writeFile(
    cliPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.84.2\\n");
  process.exit(0);
}
const { DefaultResourceLoader } = await import(new URL("./core/resource-loader.js", import.meta.url));
if (argv.includes("--list-models")) {
  const extensionModels = ${JSON.stringify(initialize)}
    ? new DefaultResourceLoader()
        .getExtensions()
        .extensions.flatMap((extension) => extension.init?.models ?? [])
        .map((model) => model.split("/").join("  ") + "  1K  1K  no  no\\n")
        .join("")
    : "";
  process.stdout.write("provider  model  context  max-out  thinking  images\\nbuiltin  demo  1K  1K  no  no\\n" + extensionModels);
  process.exit(0);
}
const loaded = new DefaultResourceLoader().getExtensions();
fs.writeFileSync(
  path.join(process.cwd(), ${JSON.stringify(ACTOR_INVOCATION_FILE)}),
  JSON.stringify({
    argv,
    spool: process.env.CAV_SPOOL ?? null,
    extensions: loaded.extensions.map((extension) => ({
      path: extension.path,
      tools: extension.tools.size,
      entry: fs.readFileSync(extension.path, "utf8"),
      init: extension.init ?? null,
    })),
  }) + "\\n",
);
process.stdout.write("READY\\n");
`,
    { mode: 0o755 },
  );
  await symlink(cliPath, path.join(created.binDir, "pi"));
  await writeFile(
    path.join(root, "dist", "core", "settings-manager.js"),
    "export const SettingsManager = { inMemory() { return {}; } };\n",
  );
  await writeFile(
    path.join(root, "dist", "core", "package-manager.js"),
    "export class DefaultPackageManager { async resolve() { return { extensions: [] }; } }\n",
  );
  await writeFile(
    path.join(root, "dist", "core", "resource-loader.js"),
    `import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const initialize = ${JSON.stringify(initialize)};
function entryFor(candidate) {
  if (!fs.statSync(candidate).isDirectory()) return candidate;
  const manifest = path.join(candidate, "package.json");
  if (fs.existsSync(manifest)) {
    const declared = JSON.parse(fs.readFileSync(manifest, "utf8")).pi?.extensions?.[0];
    if (declared) return path.resolve(candidate, declared);
  }
  return path.join(candidate, "index.js");
}
export class DefaultResourceLoader {
  getExtensions() {
    const argv = process.argv;
    const extensions = [];
    const errors = [];
    argv.forEach((argument, index) => {
      if ((argument === "--extension" || argument === "-e") && argv[index + 1]) {
        const entry = entryFor(argv[index + 1]);
        let init;
        if (initialize) {
          try {
            init = require(entry)();
          } catch (error) {
            errors.push({ path: entry, error: String(error) });
            return;
          }
        }
        extensions.push({ path: entry, tools: new Map([["mcp", {}]]), init });
      }
    });
    return { extensions, errors };
  }
}
`,
  );
}
