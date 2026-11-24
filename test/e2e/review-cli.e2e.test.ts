import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createEvalWorkspace, nativeEvalSandboxAvailable, runPioneer } from "./support/harness.js";
import { writeScriptedPi } from "./support/scripted-pi.js";

const sandboxReady = await nativeEvalSandboxAvailable();

it.skipIf(!sandboxReady)("runs a built-in-only review with a Pi home without OAuth", async () => {
  const workspace = await createEvalWorkspace("built-in-review");
  try {
    const source = path.join(workspace.root, "source");
    const report = path.join(workspace.root, "review.md");
    await mkdir(source);
    await writeScriptedPi(workspace, { version: "1.6.0", actor: { kind: "review-rpc" } });
    const result = await runPioneer(workspace, [
      "review",
      "--source",
      source,
      "--prompt",
      "Inspect this directory.",
      "--model",
      "scripted/fake-model",
      "--no-extensions",
      "--no-resume",
      "--pi-home",
      workspace.piHome,
      "--report",
      report,
      "--work-log",
      workspace.workLogPath("review"),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Scripted review report.");
    expect((await readFile(report, "utf8")).trim()).toBe("Scripted review report.");
  } finally {
    await workspace.remove();
  }
});
