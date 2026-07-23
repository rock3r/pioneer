import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  const shimSuffix = process.platform === "win32" ? ".cmd" : "";
  const shimRoot = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  await Promise.all([
    access(path.join(shimRoot, `pioneer${shimSuffix}`)),
    access(path.join(shimRoot, `pioneer-eval${shimSuffix}`)),
  ]);

  for (const script of ["review-cli.js", "eval-run-cli.js"]) {
    const scriptPath = path.join(packageRoot, "dist", script);
    const invoked = run(process.execPath, [scriptPath]);
    if (invoked.status !== 1 || !invoked.stderr.includes("Usage:") || invoked.stdout.length > 0) {
      throw new Error(`${script} did not expose its packaged CLI usage contract`);
    }
    const helped = run(process.execPath, [scriptPath, "--help"]);
    if (helped.status !== 0 || !helped.stdout.includes("Usage:") || helped.stderr.length > 0) {
      throw new Error(`${script} did not expose successful packaged CLI help`);
    }
  }

  const fakeBin = path.join(root, "fake-bin");
  await mkdir(fakeBin);
  const modelCommand = [path.join(packageRoot, "dist", "review-cli.js"), "models", "--json"];
  if (process.platform === "win32") {
    const unavailable = run(process.execPath, modelCommand, {
      env: { ...process.env, PATH: fakeBin },
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
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
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
