import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** The e2e suite drives the built CLI, so it always builds `dist/` from the current sources. */
export default function setup(): void {
  const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "build.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`Pioneer build failed with status ${String(build.status)}`);
  }
}
