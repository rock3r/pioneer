import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relativeSupervisor = path.join("sandbox", "linux-network-supervisor");
const source = path.join(repoRoot, "src", `${relativeSupervisor}.ts`);
const sourceSibling = path.join(repoRoot, "src", `${relativeSupervisor}.js`);
const built = path.join(repoRoot, "dist", `${relativeSupervisor}.js`);

function newerThanSource(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  return statSync(candidate).mtimeMs >= statSync(source).mtimeMs;
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
  if (newerThanSource(sourceSibling)) return;
  if (!newerThanSource(built)) {
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
