import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  ExtensionSnapshotBudgetError,
  mirroredExtensionStagePath,
  snapshotExtensionResources,
} from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const limits = vi.hoisted(() => ({ files: 500_000, bytes: 1024 ** 3 }));

// Shrink the cumulative scan limits, so the cases do not need a gigabyte of fixtures.
vi.mock("./pi-session-file.js", async (original) => {
  const actual = await original<typeof import("./pi-session-file.js")>();
  return {
    ...actual,
    createPiSessionScanBudget: (limitError: (detail: string) => Error) =>
      actual.createPiSessionScanBudget(limitError, { ...limits }),
  };
});

const header = `${JSON.stringify({ type: "session", id: "s", cwd: "/work" })}\n`;

async function extensionDirectory(): Promise<{ root: string; extension: string }> {
  const root = await createTempDir("extension-scan-limit-");
  const extension = path.join(root, "extensions", "reviewer");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "index.ts"), "extension");
  return { root, extension: await realpath(extension) };
}

function snapshot(root: string, extension: string, name = "snapshot"): Promise<unknown> {
  return snapshotExtensionResources(
    [{ path: path.join(extension, "index.ts"), enabled: true, metadata: { scope: "user" } }],
    path.join(root, name),
    undefined,
    { agentDir: path.join(root, "agent"), sessionDirs: [] },
  );
}

it("counts skipped session files against a cumulative scan limit", async () => {
  const { root, extension } = await extensionDirectory();
  for (const name of ["a", "b", "c"])
    await writeFile(path.join(extension, `${name}.jsonl`), header);
  limits.files = 3;
  limits.bytes = 1024 ** 3;

  await expect(snapshot(root, extension, "under")).resolves.toBeDefined();
  expect(await readdir(mirroredExtensionStagePath(path.join(root, "under"), extension))).toEqual([
    "index.ts",
  ]);

  await writeFile(path.join(extension, "d.jsonl"), header);
  const failure = snapshot(root, extension, "over");
  await expect(failure).rejects.toThrow(
    /^\[PI_EXTENSION_SNAPSHOT_LIMIT\] Extension session-history scans exceed the 3-file limit \(4 files, 0\.0 MiB read\)\. Move session history and large \.jsonl files out of extension directories\.$/u,
  );
  // The content budget hint about shared user extensions does not apply to scans.
  await expect(failure).rejects.not.toBeInstanceOf(ExtensionSnapshotBudgetError);
});

it("bounds the bytes read by scans that stay under the per-file limit", async () => {
  const { root, extension } = await extensionDirectory();
  // Each file has no parseable line until near its end, so its scan reads it almost whole.
  const padded = `${"\n".repeat(400 * 1024)}{"type":"record"}\n`;
  for (const name of ["a", "b", "c"])
    await writeFile(path.join(extension, `${name}.jsonl`), padded);
  limits.files = 500_000;
  limits.bytes = 1024 * 1024;

  await expect(snapshot(root, extension)).rejects.toThrow(
    /^\[PI_EXTENSION_SNAPSHOT_LIMIT\] Extension session-history scans exceed the 1\.0 MiB read limit \(1\.\d MiB read from 3 files\)\./u,
  );
});
