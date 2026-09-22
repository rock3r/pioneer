import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvalWorkspace,
  type EvalWorkspace,
  nativeEvalSandboxAvailable,
  runPioneer,
  SCRIPTED_CREDENTIAL_MARKER,
} from "./support/harness.js";
import {
  ACTOR_INVOCATION_FILE,
  type ScriptedActorInvocation,
  writeScriptedPi,
} from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();
const workspaces: EvalWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.remove()));
});

async function workspace(name: string): Promise<{ created: EvalWorkspace; runDir: string }> {
  const created = await createEvalWorkspace(name);
  workspaces.push(created);
  const runDir = path.join(created.root, "run");
  await mkdir(runDir);
  return { created, runDir };
}

interface WorkLogRecord {
  readonly type?: string;
  readonly stage?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
}

async function readWorkLog(logPath: string): Promise<WorkLogRecord[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as WorkLogRecord);
}

describe.skipIf(!sandboxReady)("pioneer eval run actor lifecycle", () => {
  it("completes a minimal no-tools Pi actor with exactly the requested output", async () => {
    const { created, runDir } = await workspace("minimal-actor");
    await writeScriptedPi(created, { actor: { kind: "reply-verbatim" } });

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("minimal-actor"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--no-extensions",
      "--model",
      "scripted/fake-model",
      "--no-tools",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("OK\n");
    expect(run.stderr).not.toContain("[EVAL_");
  });

  it("gives the isolated Pi home the credential locks current Pi creates", async () => {
    const { created, runDir } = await workspace("credential-lock");
    await writeScriptedPi(created, { actor: { kind: "credential-lock" } });
    const workLogPath = created.workLogPath("credential-lock");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      workLogPath,
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--no-extensions",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.stderr).not.toMatch(/EPERM|lock-failed/);
    expect(run.exitCode).toBe(0);
    const actorResult = JSON.parse(run.stdout) as {
      agentDir: string;
      credentialsReadable: boolean;
      locks: string;
    };
    expect(actorResult).toMatchObject({ credentialsReadable: true, locks: "created" });
    // The snapshot lives outside the persistent run directory and is removed afterwards.
    expect(path.relative(runDir, actorResult.agentDir).startsWith("..")).toBe(true);
    expect(existsSync(actorResult.agentDir)).toBe(false);
    expect(await readFile(path.join(created.piHome, "auth.json"), "utf8")).toContain(
      SCRIPTED_CREDENTIAL_MARKER,
    );
  });

  it("starts Pi actors with the documented fast-start flags and an isolated agent directory", async () => {
    const { created, runDir } = await workspace("startup-flags");
    await writeScriptedPi(created, { actor: { kind: "credential-lock" } });

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("startup-flags"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--no-extensions",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode).toBe(0);
    const invocation = JSON.parse(
      await readFile(path.join(runDir, ACTOR_INVOCATION_FILE), "utf8"),
    ) as ScriptedActorInvocation;
    expect(invocation.argv).toEqual(
      expect.arrayContaining([
        "--offline",
        "--no-session",
        "--no-approve",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--no-skills",
      ]),
    );
    expect(invocation.cwd).toBe(runDir);
    expect(invocation.piAgentDir).not.toBeNull();
    expect(path.relative(runDir, invocation.piAgentDir ?? "").startsWith("..")).toBe(true);
  });

  it.each([
    ["pi command", "pi", "load"],
    ["declared cli.js path", "cli.js", "load"],
    ["declared cli.js without extensions", "cli.js", "builtin"],
    ["declared cli.js rejects an unknown model", "cli.js", "reject"],
    ["brokers oauth without user extensions", "cli.js", "oauth"],
    ["strips tools from an explicit extension", "cli.js", "explicit"],
    ["strips tools from an explicit short extension flag", "cli.js", "explicit-short"],
    ["rejects an explicit extension directory", "cli.js", "directory"],
    ["loads a relative explicit extension from its staged copy", "cli.js", "relative"],
    ["stages a repeated explicit extension once", "cli.js", "duplicate"],
    ["rejects an extension directly in a shared temp directory", "cli.js", "shared-temp"],
    ["rejects an extension inside private Pi session storage", "cli.js", "private-session"],
    ["rejects an extension directly in the Pi agent directory", "cli.js", "agent-root"],
    ["rejects an extension above the Pi agent directory", "cli.js", "agent-ancestor"],
    ["rejects an extension inside a credential directory", "cli.js", "credential-dir"],
    ["reuses an enabled extension named again on the command", "cli.js", "overlap"],
    ["reuses a sibling of an enabled extension", "cli.js", "sibling"],
  ] as const)(
    "loads an enabled user extension inside the sandboxed Pi actor (%s)",
    async (label, entry, mode) => {
      const { created, runDir } = await workspace(
        `extension-provider-${label.replaceAll(" ", "-")}`,
      );
      const extensionDirectory = path.join(created.root, "user-extensions");
      const extensionSource = path.join(extensionDirectory, "provider.ts");
      const extensionMarker = "extension-provider-marker\n";
      const cliPath = path.join(created.piPackageRoot, "dist", "cli.js");
      await mkdir(extensionDirectory);
      await writeFile(extensionSource, extensionMarker);
      if (mode === "overlap" || mode === "sibling") {
        await symlink(extensionSource, path.join(extensionDirectory, "provider-link.ts"));
      }
      if (mode === "sibling") {
        await writeFile(path.join(extensionDirectory, "helper.ts"), "helper\n");
      }
      await mkdir(path.join(created.piPackageRoot, "dist", "core"), { recursive: true });
      await writeFile(
        path.join(created.piPackageRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "@earendil-works/pi-coding-agent",
            version: "0.84.2",
            type: "module",
            bin: { pi: "dist/cli.js" },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        cliPath,
        `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.84.2\\n");
  process.exit(0);
}
if (argv.includes("--list-models")) {
  const explicit = argv.includes("--extension") || argv.includes("-e");
  const row = explicit
    ? "extension-provider  demo  1K  1K  no  no"
    : "builtin  demo  1K  1K  no  no";
  process.stdout.write("provider  model  context  max-out  thinking  images\\n" + row + "\\n");
  process.exit(0);
}
if (argv.includes("--no-extensions") && !argv.includes("--extension")) {
  fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
}
const extensionIndex = argv.findIndex((argument) => argument === "--extension" || argument === "-e");
const extensionPath = extensionIndex < 0 ? undefined : argv[extensionIndex + 1];
let extensionText = "";
let siblingText = "";
if (extensionPath !== undefined) {
  extensionText = fs.readFileSync(extensionPath, "utf8");
  try {
    siblingText = fs.readFileSync(path.join(path.dirname(extensionPath), "helper.mjs"), "utf8");
  } catch {
    siblingText = "";
  }
}
const { DefaultResourceLoader } = await import(
  new URL("./core/resource-loader.js", import.meta.url),
);
const loaded = new DefaultResourceLoader().getExtensions();
const tools = loaded.extensions[0]?.tools;
const toolCount = tools instanceof Map ? tools.size : null;
fs.writeFileSync(
  path.join(process.cwd(), ${JSON.stringify(ACTOR_INVOCATION_FILE)}),
  JSON.stringify({
    argv,
    cwd: process.cwd(),
    piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    extensionText,
    siblingText,
    brokerConfigured: Boolean(process.env.PIONEER_AUTH_BROKER_URL),
    toolCount,
  }) + "\\n",
);
process.stdout.write("READY\\n");
`,
        { mode: 0o755 },
      );
      await symlink(cliPath, path.join(created.binDir, "pi"));
      await writeFile(
        path.join(created.piPackageRoot, "dist", "core", "settings-manager.js"),
        "export const SettingsManager = { inMemory() { return {}; } };\n",
      );
      await writeFile(
        path.join(created.piPackageRoot, "dist", "core", "package-manager.js"),
        `export class DefaultPackageManager {
  async resolve() {
    return {
      extensions: [
        {
          path: ${JSON.stringify(extensionSource)},
          enabled: true,
          metadata: { scope: "user" },
        },
      ],
    };
  }
}
`,
      );
      await writeFile(
        path.join(created.piPackageRoot, "dist", "core", "resource-loader.js"),
        mode === "explicit" || mode === "explicit-short"
          ? `export class DefaultResourceLoader {
  getExtensions() {
    return {
      extensions: [{ path: "explicit", tools: new Map([["bash", {}]]) }],
      errors: [],
    };
  }
}
`
          : "export class DefaultResourceLoader { getExtensions() { return { extensions: [], errors: [] }; } }\n",
      );
      if (mode === "explicit" || mode === "explicit-short") {
        await writeFile(
          path.join(created.piPackageRoot, "explicit-extension.mjs"),
          "explicit-extension-marker\n",
        );
      }
      if (mode === "directory") {
        await mkdir(path.join(created.piPackageRoot, "explicit-extension-dir"));
      }
      if (mode === "relative" || mode === "duplicate") {
        await writeFile(path.join(runDir, "provider.mjs"), "explicit-extension-marker\n");
        await writeFile(path.join(runDir, "helper.mjs"), "helper-marker\n");
      }
      const sharedTempExtension = path.join(
        os.tmpdir(),
        `pioneer-explicit-${process.pid}-${Date.now()}.mjs`,
      );
      if (mode === "shared-temp") {
        await writeFile(sharedTempExtension, "explicit-extension-marker\n");
      }
      const privateSessionExtension = path.join(created.piHome, "sessions", "provider.mjs");
      if (mode === "private-session") {
        await mkdir(path.dirname(privateSessionExtension), { recursive: true });
        await writeFile(privateSessionExtension, "explicit-extension-marker\n");
      }
      const agentRootExtension = path.join(created.piHome, "provider.mjs");
      if (mode === "agent-root") {
        await writeFile(agentRootExtension, "explicit-extension-marker\n");
      }
      const agentAncestorExtension = path.join(created.root, "outside-agent.mjs");
      if (mode === "agent-ancestor") {
        await writeFile(agentAncestorExtension, "explicit-extension-marker\n");
      }
      const credentialExtension = path.join(created.root, ".ssh", "provider.mjs");
      if (mode === "credential-dir") {
        await mkdir(path.dirname(credentialExtension), { recursive: true });
        await writeFile(credentialExtension, "explicit-extension-marker\n");
      }
      const extensionArgs =
        mode === "explicit"
          ? ["--extension", path.join(created.piPackageRoot, "explicit-extension.mjs")]
          : mode === "explicit-short"
            ? ["-e", path.join(created.piPackageRoot, "explicit-extension.mjs")]
            : mode === "directory"
              ? ["--extension", path.join(created.piPackageRoot, "explicit-extension-dir")]
              : mode === "relative"
                ? ["-e", "./provider.mjs"]
                : mode === "duplicate"
                  ? ["-e", "./provider.mjs", "-e", "./provider.mjs"]
                  : mode === "shared-temp"
                    ? ["--extension", sharedTempExtension]
                    : mode === "private-session"
                      ? ["--extension", privateSessionExtension]
                      : mode === "agent-root"
                        ? ["--extension", agentRootExtension]
                        : mode === "agent-ancestor"
                          ? ["--extension", agentAncestorExtension]
                          : mode === "credential-dir"
                            ? ["--extension", credentialExtension]
                            : mode === "overlap"
                              ? ["--extension", extensionSource]
                              : mode === "sibling"
                                ? ["--extension", path.join(extensionDirectory, "helper.ts")]
                                : [];
      if (mode === "oauth") {
        await writeFile(
          path.join(created.piHome, "auth.json"),
          `${JSON.stringify({
            scripted: {
              type: "oauth",
              access: "scripted-oauth-access",
              refresh: "scripted-oauth-refresh",
              expires: 1,
            },
          })}\n`,
          { mode: 0o600 },
        );
        await writeFile(
          path.join(created.piPackageRoot, "dist", "core", "auth-storage.js"),
          `export class AuthStorage {
  async modify(_provider, update) { return await update(); }
}
export class FileAuthStorageBackend {
  constructor(file) { this.file = file; }
  async withLockAsync(operation) {
    const { readFile, writeFile } = await import("node:fs/promises");
    let current;
    try { current = await readFile(this.file, "utf8"); } catch { current = undefined; }
    const outcome = await operation(current);
    if (outcome.next !== undefined) await writeFile(this.file, outcome.next);
    return outcome.result;
  }
}
`,
        );
      }

      const run = await runPioneer(created, [
        "eval",
        "run",
        "--run-dir",
        runDir,
        "--pi-home",
        created.piHome,
        "--work-log",
        created.workLogPath(`extension-provider-${label.replaceAll(" ", "-")}`),
        "--timeout-ms",
        "60000",
        "--",
        entry === "cli.js" ? cliPath : "pi",
        ...(mode === "load" || mode === "overlap" || mode === "sibling"
          ? []
          : (["--no-extensions"] as const)),
        ...extensionArgs,
        "--model",
        mode === "reject"
          ? "missing/no-such-model"
          : mode === "load" ||
              mode === "explicit" ||
              mode === "explicit-short" ||
              mode === "relative" ||
              mode === "duplicate" ||
              mode === "overlap" ||
              mode === "sibling"
            ? "extension-provider/demo"
            : "builtin/demo",
        "--print",
        "Say READY",
      ]);

      if (
        mode !== "directory" &&
        mode !== "shared-temp" &&
        mode !== "private-session" &&
        mode !== "agent-root" &&
        mode !== "agent-ancestor" &&
        mode !== "credential-dir"
      ) {
        expect(run.stderr).not.toMatch(/PI_EXTENSION_|PI_OAUTH_/);
      }
      if (
        mode === "directory" ||
        mode === "shared-temp" ||
        mode === "private-session" ||
        mode === "agent-root" ||
        mode === "agent-ancestor" ||
        mode === "credential-dir"
      ) {
        try {
          expect(run.exitCode, run.stderr).not.toBe(0);
          expect(run.stderr).toContain(
            mode === "directory"
              ? "regular file"
              : mode === "shared-temp"
                ? "dedicated directory"
                : mode === "private-session"
                  ? "private Pi session or log storage"
                  : mode === "credential-dir"
                    ? "credential directory"
                    : "Pi agent directory",
          );
        } finally {
          if (mode === "shared-temp") await unlink(sharedTempExtension).catch(() => undefined);
        }
        return;
      }
      if (mode === "reject") {
        expect(run.exitCode, run.stderr).not.toBe(0);
        expect(run.stderr).toContain("Configured Pi models:");
        expect(existsSync(path.join(runDir, ACTOR_INVOCATION_FILE))).toBe(false);
        return;
      }
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("READY");
      const invocation = JSON.parse(
        await readFile(path.join(runDir, ACTOR_INVOCATION_FILE), "utf8"),
      ) as ScriptedActorInvocation & {
        extensionText?: string;
        siblingText?: string;
        brokerConfigured?: boolean;
        toolCount?: number | null;
      };
      if (mode === "relative") {
        const flagIndex = invocation.argv.indexOf("-e");
        const extensionPath = invocation.argv[flagIndex + 1] ?? "";
        expect(extensionPath).not.toBe("./provider.mjs");
        expect(path.relative(runDir, extensionPath).startsWith("..")).toBe(true);
        expect(invocation.extensionText).toBe("explicit-extension-marker\n");
        expect(invocation.siblingText).toBe("helper-marker\n");
      } else if (mode === "duplicate") {
        const paths = invocation.argv.flatMap((argument, index) =>
          argument === "-e" ? [invocation.argv[index + 1] ?? ""] : [],
        );
        expect(paths).toHaveLength(2);
        expect(paths[0]).toBe(paths[1]);
        expect(paths[0]).not.toBe("./provider.mjs");
        expect(path.relative(runDir, paths[0] ?? "").startsWith("..")).toBe(true);
      } else if (mode === "explicit" || mode === "explicit-short") {
        expect(invocation.argv).toContain("--no-extensions");
        expect(invocation.argv).toContain(mode === "explicit-short" ? "-e" : "--extension");
        expect(invocation.extensionText).toBe("explicit-extension-marker\n");
        expect(invocation.toolCount).toBe(0);
        expect(invocation.brokerConfigured).toBe(false);
      } else if (mode === "oauth") {
        expect(invocation.argv).toContain("--no-extensions");
        expect(invocation.argv).not.toContain("--extension");
        expect(invocation.extensionText).toBe("");
        expect(invocation.brokerConfigured).toBe(true);
        expect(await readFile(path.join(created.piHome, "auth.json"), "utf8")).toContain(
          "scripted-oauth-access",
        );
      } else if (mode === "builtin") {
        expect(invocation.argv).toEqual(
          expect.arrayContaining([
            "--offline",
            "--no-session",
            "--no-approve",
            "--no-skills",
            "--no-extensions",
          ]),
        );
        expect(invocation.argv).not.toContain("--extension");
        expect(invocation.extensionText).toBe("");
      } else {
        expect(invocation.argv).toEqual(expect.arrayContaining(["--no-extensions", "--extension"]));
        expect(invocation.extensionText).toBe(extensionMarker);
      }
    },
  );

  it("fails closed when a trusted Pi package cannot host the extension adapter", async () => {
    const { created, runDir } = await workspace("unsupported-extension-runtime");
    await writeScriptedPi(created, { actor: { kind: "reply-verbatim" } });

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      created.workLogPath("unsupported-extension-runtime"),
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode, run.stderr).not.toBe(0);
    expect(run.stderr).toContain("PI_EXTENSION_RUNTIME_UNSUPPORTED");
  });

  it("writes a stage work log that never records prompts or credentials", async () => {
    const { created, runDir } = await workspace("work-log");
    await writeScriptedPi(created, { actor: { kind: "credential-lock" } });
    const workLogPath = created.workLogPath("stages");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      workLogPath,
      "--timeout-ms",
      "60000",
      "--",
      "pi",
      "--no-extensions",
      "--model",
      "scripted/fake-model",
      "--print",
      "unmistakable-prompt-text",
    ]);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(`[PIONEER_EVAL_WORK_LOG] ${workLogPath}`);
    const records = await readWorkLog(workLogPath);
    expect(records.map((record) => record.stage).filter(Boolean)).toEqual(
      expect.arrayContaining([
        "sandbox_readiness",
        "pi_readiness",
        "pi_home_snapshot",
        "network_proxy",
        "isolation_probe",
        "actor",
        "cleanup",
      ]),
    );
    expect(records.at(-1)?.type).toBe("eval_completed");
    const raw = await readFile(workLogPath, "utf8");
    expect(raw).not.toContain("unmistakable-prompt-text");
    expect(raw).not.toContain(SCRIPTED_CREDENTIAL_MARKER);
  });

  it("kills a hanging actor process tree and still returns its captured output", async () => {
    const { created, runDir } = await workspace("timeout");
    await writeScriptedPi(created, { actor: { kind: "hang-with-descendant" } });
    const workLogPath = created.workLogPath("timeout");

    const run = await runPioneer(created, [
      "eval",
      "run",
      "--run-dir",
      runDir,
      "--pi-home",
      created.piHome,
      "--work-log",
      workLogPath,
      "--timeout-ms",
      "2000",
      "--",
      "pi",
      "--no-extensions",
      "--model",
      "scripted/fake-model",
      "--print",
      "Reply with exactly: OK",
    ]);

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toContain("scripted-actor-started");
    expect(run.stderr).toContain("scripted-actor-thinking");
    expect(run.stderr).toContain("[EVAL_TIMEOUT]");
    // The timeout terminates the descendant that holds the inherited pipes, so the
    // controller settles promptly instead of waiting for its own hard kill.
    expect(run.durationMs).toBeLessThan(30_000);
    const records = await readWorkLog(workLogPath);
    expect(records.some((record) => record.stage === "actor" && record.timedOut === true)).toBe(
      true,
    );
    expect(records.at(-1)?.type).toBe("eval_completed");
  });
});
