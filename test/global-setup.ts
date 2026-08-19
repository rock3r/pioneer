import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relativeSupervisor = path.join("sandbox", "linux-network-supervisor");
const source = path.join(repoRoot, "src", `${relativeSupervisor}.ts`);
const sourceSibling = path.join(repoRoot, "src", `${relativeSupervisor}.js`);
const built = path.join(repoRoot, "dist", `${relativeSupervisor}.js`);

/**
 * The emitted supervisor depends on more than its own source: the build configuration, the
 * build script, and the compiler version all change its output. Comparing against the newest
 * of them keeps a stale artifact from surviving a toolchain or configuration change.
 */
const buildInputs = [
  source,
  path.join(repoRoot, "tsconfig.json"),
  path.join(repoRoot, "tsconfig.build.json"),
  path.join(repoRoot, "scripts", "build.mjs"),
  path.join(repoRoot, "node_modules", "typescript", "package.json"),
];

function newestBuildInputMs(): number {
  return Math.max(...buildInputs.map((input) => (existsSync(input) ? statSync(input).mtimeMs : 0)));
}

function isFresh(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  return statSync(candidate).mtimeMs >= newestBuildInputMs();
}

/**
 * `buildLinuxSandboxArgv` binds the Linux network supervisor from the compiled sibling of
 * the launcher module, which is the only layout that exists in a published install. A suite
 * running from the TypeScript sources has no such sibling, so every proxied Bubblewrap launch
 * would fail with `bwrap: Can't find source path`. Compiling the supervisor next to its source
 * keeps source-mode runs on the same production resolution instead of skipping Linux coverage.
 *
 * The artifact is reused from `dist/` so the emitted JavaScript always comes from the project
 * build configuration rather than a duplicated compiler invocation.
 */
export default function setup(): void {
  if (isFresh(sourceSibling)) return;
  if (!isFresh(built)) {
    const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "build.mjs")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (build.error) throw build.error;
    if (build.status !== 0) {
      throw new Error(`Pioneer build failed with status ${String(build.status)}`);
    }
  }
  copyFileSync(built, sourceSibling);
}
