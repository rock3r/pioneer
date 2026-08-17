import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options });
  if (result.error) throw result.error;
  return result;
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? run(process.execPath, [npmExecPath, ...args], options)
    : run("npm", args, options);
}

function environmentWithPath(value) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
    ),
    PATH: value,
  };
}

async function findTarball(candidate) {
  const absolute = path.resolve(candidate);
  const entries = await readdir(absolute).catch(() => undefined);
  if (entries === undefined) return absolute;
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected exactly one package tarball in ${absolute}, found ${tarballs.length}`,
    );
  }
  return path.join(absolute, tarballs[0]);
}

const root = await mkdtemp(path.join(os.tmpdir(), "pioneer-package-smoke-"));
try {
  let tarball;
  if (process.argv[2]) {
    tarball = await findTarball(process.argv[2]);
  } else {
    const packed = runNpm(["pack", "--silent", "--pack-destination", root], {
      cwd: process.cwd(),
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    tarball = await findTarball(root);
  }

  const prefix = path.join(root, "install");
  const installed = runNpm([
    "install",
    "--global",
    "--ignore-scripts",
    "--prefix",
    prefix,
    tarball,
  ]);
  if (installed.status !== 0) throw new Error(`tarball install failed: ${installed.stderr}`);

  const packageRoot =
    process.platform === "win32"
      ? path.join(prefix, "node_modules", "@rock3r", "pioneer")
      : path.join(prefix, "lib", "node_modules", "@rock3r", "pioneer");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const sourceManifest = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  );
  if (manifest.name !== "@rock3r/pioneer" || manifest.version !== sourceManifest.version) {
    throw new Error(`unexpected installed package identity: ${manifest.name}@${manifest.version}`);
  }
  await access(path.join(packageRoot, "plugins", "pioneer", "assets", "pioneer-mascot.png"));
  await access(path.join(packageRoot, "plugins", "pioneer", "assets", "pioneer-banner.jpg"));
  await access(path.join(packageRoot, "plugins", "pioneer", "plugin.json"));
  await access(path.join(packageRoot, "plugins", "pioneer", ".codex-plugin", "plugin.json"));
  await access(path.join(packageRoot, "plugins", "pioneer", ".claude-plugin", "plugin.json"));
  await access(path.join(packageRoot, "plugins", "pioneer", "skills", "pioneer", "SKILL.md"));
  await access(path.join(packageRoot, "plugins", "pioneer", "README.md"));
  await access(path.join(packageRoot, "plugins", "pioneer", "LICENSE"));
  await access(path.join(packageRoot, "pi-compatibility.json"));
  const legacyEvalCliPresent = await access(path.join(packageRoot, "dist", "eval-run-cli.js")).then(
    () => true,
    () => false,
  );
  if (legacyEvalCliPresent) {
    throw new Error(`packed artifact retained the removed pioneer-eval entry point`);
  }

  const consumerRoot = path.join(root, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  const consumerInstall = runNpm([
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--prefix",
    consumerRoot,
    tarball,
  ]);
  if (consumerInstall.status !== 0) {
    throw new Error(`consumer package install failed: ${consumerInstall.stderr}`);
  }
  const rootImport = run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const loaded = await import('@rock3r/pioneer'); if (typeof loaded.runReview !== 'function') throw new Error('runReview export missing');",
    ],
    { cwd: consumerRoot },
  );
  if (rootImport.status !== 0) {
    throw new Error(`package-root API import failed: ${rootImport.stderr || rootImport.stdout}`);
  }

  const shimSuffix = process.platform === "win32" ? ".cmd" : "";
  const shimRoot = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  await access(path.join(shimRoot, `pioneer${shimSuffix}`));

  for (const script of ["review-cli.js"]) {
    const scriptPath = path.join(packageRoot, "dist", script);
    const invoked = run(process.execPath, [scriptPath]);
    if (invoked.status !== 1 || !invoked.stderr.includes("Usage:") || invoked.stdout.length > 0) {
      throw new Error(`${script} did not expose its packaged CLI usage contract`);
    }
    const helped = run(process.execPath, [scriptPath, "--help"]);
    if (helped.status !== 0 || !helped.stdout.includes("Usage:") || helped.stderr.length > 0) {
      throw new Error(`${script} did not expose successful packaged CLI help`);
    }
    const versioned = run(process.execPath, [scriptPath, "--version"]);
    if (
      versioned.status !== 0 ||
      versioned.stdout.trim() !== manifest.version ||
      versioned.stderr.length > 0
    ) {
      throw new Error(`${script} did not expose its packaged version`);
    }
  }

  const primaryCli = path.join(packageRoot, "dist", "review-cli.js");
  const primaryHelp = run(process.execPath, [primaryCli, "--help"]);
  if (
    primaryHelp.status !== 0 ||
    !primaryHelp.stdout.includes("pioneer eval prepare") ||
    !primaryHelp.stdout.includes("pioneer doctor") ||
    !primaryHelp.stdout.includes("--report FILE")
  ) {
    throw new Error(`primary CLI did not advertise unified review/eval commands`);
  }
  const invalidReportPath = run(process.execPath, [
    primaryCli,
    "review",
    ...(process.platform === "win32" ? ["--allow-unsandboxed-windows"] : []),
    "--source",
    process.cwd(),
    "--prompt",
    "Review",
    "--report",
    "relative.md",
  ]);
  if (
    invalidReportPath.status !== 1 ||
    !invalidReportPath.stderr.includes("Review report path is not absolute") ||
    invalidReportPath.stdout.length > 0
  ) {
    throw new Error(
      `packaged review CLI did not reject a relative report path: ${invalidReportPath.stderr || invalidReportPath.stdout}`,
    );
  }
  const evalVersion = run(process.execPath, [primaryCli, "eval", "--version"]);
  if (
    evalVersion.status !== 0 ||
    evalVersion.stdout.trim() !== manifest.version ||
    evalVersion.stderr.length > 0
  ) {
    throw new Error(`pioneer eval did not route through the primary CLI`);
  }
  const evalHelp = run(process.execPath, [primaryCli, "eval", "--help"]);
  if (
    evalHelp.status !== 0 ||
    !evalHelp.stdout.includes("pioneer eval prepare") ||
    evalHelp.stdout.includes("pioneer review")
  ) {
    throw new Error(`pioneer eval did not expose eval-scoped help`);
  }
  for (const subcommand of ["review", "models", "doctor"]) {
    const subcommandHelp = run(process.execPath, [primaryCli, subcommand, "--help"]);
    if (
      subcommandHelp.status !== 0 ||
      !subcommandHelp.stdout.includes("Usage:") ||
      subcommandHelp.stderr.length > 0
    ) {
      throw new Error(`pioneer ${subcommand} --help did not succeed on stdout`);
    }
  }

  const fakeRpc = path.join(root, "fake-rpc.mjs");
  await writeFile(
    fakeRpc,
    `process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Packed report" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`,
  );
  const fakeMissingRpc = path.join(root, "fake-missing-rpc.mjs");
  await writeFile(
    fakeMissingRpc,
    `process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`,
  );
  const fakeFailedRpc = path.join(root, "fake-failed-rpc.mjs");
  await writeFile(
    fakeFailedRpc,
    `process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Failed report" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  process.stdout.end(() => process.exit(2));
});
`,
  );
  const fakeIncompleteRpc = path.join(root, "fake-incomplete-rpc.mjs");
  await writeFile(
    fakeIncompleteRpc,
    `process.stdin.once("data", () => {
  process.exit(2);
});
`,
  );
  const packagedRunner = pathToFileURL(path.join(packageRoot, "dist", "review", "runner.js")).href;
  const packagedReportOutput = pathToFileURL(
    path.join(packageRoot, "dist", "review", "report-output.js"),
  ).href;
  const packagedReportPath = path.join(root, "packaged-report.md");
  const rpcContract = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { readFile } from "node:fs/promises";
import { runReviewRpc } from ${JSON.stringify(packagedRunner)};
import { writeReviewReport } from ${JSON.stringify(packagedReportOutput)};
const report = await runReviewRpc([process.execPath, ${JSON.stringify(fakeRpc)}], process.cwd(), process.env, "Review", 1000);
if (report !== "Packed report") throw new Error("packaged report was not returned");
for (const [fixture, diagnostic] of [
  [${JSON.stringify(fakeMissingRpc)}, "[REVIEW_REPORT_MISSING]"],
  [${JSON.stringify(fakeFailedRpc)}, "[REVIEW_PROCESS_FAILED]"],
  [${JSON.stringify(fakeIncompleteRpc)}, "[REVIEW_RPC_INCOMPLETE]"],
]) {
  try {
    await runReviewRpc([process.execPath, fixture], process.cwd(), process.env, "Review", 1000);
    throw new Error("packaged terminal failure was accepted");
  } catch (error) {
    if (!String(error).includes(diagnostic)) throw error;
  }
}
await writeReviewReport(${JSON.stringify(packagedReportPath)}, "Packed report");
if (await readFile(${JSON.stringify(packagedReportPath)}, "utf8") !== "Packed report\\n") {
  throw new Error("packaged report writer did not persist the report");
}
try {
  await writeReviewReport(${JSON.stringify(packagedReportPath)}, "replacement");
  throw new Error("packaged report writer overwrote an existing target");
} catch (error) {
  if (!String(error).includes("already exists")) throw error;
}
`,
  ]);
  if (rpcContract.status !== 0) {
    throw new Error(
      `packaged review RPC contract failed: ${rpcContract.stderr || rpcContract.stdout}`,
    );
  }

  const fakeBin = path.join(root, "fake-bin");
  await mkdir(fakeBin);
  const modelCommand = [path.join(packageRoot, "dist", "review-cli.js"), "models", "--json"];
  if (process.platform === "win32") {
    const unavailable = run(process.execPath, modelCommand, {
      env: environmentWithPath(fakeBin),
    });
    if (
      unavailable.status !== 1 ||
      !unavailable.stderr.includes("[PI_NOT_FOUND]") ||
      unavailable.stdout.length > 0
    ) {
      throw new Error(
        `packaged Windows model listing did not expose PI_NOT_FOUND: ${unavailable.stderr}`,
      );
    }
  } else {
    const fakePiScript = path.join(root, "fake-pi.mjs");
    await writeFile(
      fakePiScript,
      `const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("0.81.1\\n");
} else if (args.includes("--list-models")) {
  process.stdout.write("provider  model          context  max-out  thinking  images\\nopenrouter x-ai/grok-4.5 500K     4.1K     yes       yes\\nxai        grok-4.5      500K     500K     yes       yes\\n");
} else {
  process.exitCode = 2;
}
`,
    );
    const fakePi = path.join(fakeBin, "pi");
    await writeFile(
      fakePi,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePiScript)} "$@"\n`,
    );
    await chmod(fakePi, 0o755);

    const listed = run(process.execPath, modelCommand, {
      env: environmentWithPath(`${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`),
    });
    if (listed.status !== 0) throw new Error(`packaged model listing failed: ${listed.stderr}`);
    const catalog = JSON.parse(listed.stdout);
    const names = catalog.models.map((model) => model.qualifiedName);
    if (
      catalog.schemaVersion !== 1 ||
      names.join(",") !== "openrouter/x-ai/grok-4.5,xai/grok-4.5"
    ) {
      throw new Error(`unexpected packaged model catalog: ${listed.stdout}`);
    }
  }
  process.stdout.write(`packed artifact smoke passed: ${manifest.name}@${manifest.version}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
