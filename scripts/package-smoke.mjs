import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  if (manifest.name !== "@rock3r/pioneer" || manifest.version !== "0.1.0") {
    throw new Error(`unexpected installed package identity: ${manifest.name}@${manifest.version}`);
  }
  await access(path.join(packageRoot, "plugins", "pioneer", "assets", "pioneer-mascot.png"));

  const shimSuffix = process.platform === "win32" ? ".cmd" : "";
  const shimRoot = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  await Promise.all([
    access(path.join(shimRoot, `pioneer${shimSuffix}`)),
    access(path.join(shimRoot, `pioneer-eval${shimSuffix}`)),
  ]);

  for (const script of ["review-cli.js", "eval-run-cli.js"]) {
    const invoked = run(process.execPath, [path.join(packageRoot, "dist", script)]);
    if (invoked.status !== 1 || !invoked.stderr.includes("Usage:")) {
      throw new Error(`${script} did not expose its packaged CLI usage contract`);
    }
  }
  process.stdout.write(`packed artifact smoke passed: ${manifest.name}@${manifest.version}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
