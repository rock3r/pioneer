import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
rmSync(path.join(root, "dist"), { recursive: true, force: true });

const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  copyFileSync(
    path.join(root, "src", "review", "windows-process-start.js"),
    path.join(root, "dist", "review", "windows-process-start.js"),
  );
  mkdirSync(path.join(root, "dist", "deep-review", "inspection-extension"), { recursive: true });
  copyFileSync(
    path.join(root, "src", "deep-review", "inspection-extension", "index.ts"),
    path.join(root, "dist", "deep-review", "inspection-extension", "index.ts"),
  );
}
