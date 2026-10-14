import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { prepareIsolatedPiHome } from "./pi-home.js";

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

async function piHome(): Promise<{ root: string; source: string; skill: string }> {
  const root = await createTempDir("pi-home-scan-limit-");
  const source = path.join(root, "agent");
  await mkdir(path.join(source, "skills", "review"), { recursive: true });
  await writeFile(path.join(source, "settings.json"), "{}");
  const canonical = await realpath(source);
  return { root, source: canonical, skill: path.join(canonical, "skills", "review") };
}

function prepare(root: string, source: string, name = "pi"): Promise<unknown> {
  return prepareIsolatedPiHome({
    sourceDir: source,
    destination: path.join(root, "run", name),
    mode: "review",
    environment: {},
  });
}

it("counts skipped session files against a cumulative scan limit", async () => {
  const { root, source, skill } = await piHome();
  for (const name of ["a", "b", "c"]) await writeFile(path.join(skill, `${name}.jsonl`), header);
  limits.files = 3;
  limits.bytes = 1024 ** 3;

  await expect(prepare(root, source, "under")).resolves.toBeDefined();
  expect(await readdir(path.join(root, "run", "under", "agent", "skills", "review"))).toEqual([]);

  await writeFile(path.join(skill, "d.jsonl"), header);
  await expect(prepare(root, source, "over")).rejects.toThrow(
    /^\[PI_HOME_SNAPSHOT_LIMIT\] Pi home session-history scans exceed the 3-file limit \(4 files, 0\.0 MiB read\)\. Move session history and large \.jsonl files out of the Pi home skills and included paths\.$/u,
  );
});

it("bounds the bytes read by scans that stay under the per-file limit", async () => {
  const { root, source, skill } = await piHome();
  // Each file has no parseable line until near its end, so its scan reads it almost whole.
  const padded = `${"\n".repeat(400 * 1024)}{"type":"record"}\n`;
  for (const name of ["a", "b", "c"]) await writeFile(path.join(skill, `${name}.jsonl`), padded);
  limits.files = 500_000;
  limits.bytes = 1024 * 1024;

  await expect(prepare(root, source)).rejects.toThrow(
    /^\[PI_HOME_SNAPSHOT_LIMIT\] Pi home session-history scans exceed the 1\.0 MiB read limit \(1\.\d MiB read from 3 files\)\./u,
  );
});

it.skipIf(process.platform === "win32")(
  "charges the target scans of .jsonl links to the same limit",
  async () => {
    const { root, source, skill } = await piHome();
    await writeFile(path.join(skill, "data.txt"), '{"type":"record"}\n');
    for (const name of ["a", "b"]) await symlink("data.txt", path.join(skill, `${name}.jsonl`));
    // Validation and copy each check both links, so a three-file limit is passed on the copy.
    limits.files = 3;
    limits.bytes = 1024 ** 3;

    await expect(prepare(root, source)).rejects.toThrow(
      "[PI_HOME_SNAPSHOT_LIMIT] Pi home session-history scans exceed the 3-file limit (4 files",
    );
  },
);
