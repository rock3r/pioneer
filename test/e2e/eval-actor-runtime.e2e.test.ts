import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
});

/**
 * A trusted Pi package that can host Pioneer's extension adapter. Its resource loader
 * reports every `--extension` it was given, resolving a directory to its package entry the
 * way Pi does, with one tool each; the adapter decides which tools survive.
 */
async function writeExtensionHostingPi(created: EvalWorkspace): Promise<void> {
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
if (argv.includes("--list-models")) {
  process.stdout.write("provider  model  context  max-out  thinking  images\\nbuiltin  demo  1K  1K  no  no\\n");
  process.exit(0);
}
const { DefaultResourceLoader } = await import(new URL("./core/resource-loader.js", import.meta.url));
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
import path from "node:path";
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
    argv.forEach((argument, index) => {
      if ((argument === "--extension" || argument === "-e") && argv[index + 1]) {
        extensions.push({ path: entryFor(argv[index + 1]), tools: new Map([["mcp", {}]]) });
      }
    });
    return { extensions, errors: [] };
  }
}
`,
  );
}
