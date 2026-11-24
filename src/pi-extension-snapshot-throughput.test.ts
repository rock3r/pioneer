import { constants } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { validateCachedExtensionSnapshot } from "./pi-extension-cache-validation.js";
import {
  planExtensionSnapshot,
  snapshotExtensionResources,
  stageExtensionSnapshot,
} from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const probe = vi.hoisted(() => ({
  delayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
  modes: [] as (number | undefined)[],
  realpathSyncCalls: 0,
  reads: [] as unknown[],
}));

// Observe copy concurrency and flags, which real timing cannot show reliably.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: (...args: Parameters<typeof fs.open>) => {
      probe.reads.push(args[0]);
      return fs.open(...args);
    },
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      probe.reads.push(args[0]);
      return fs.readFile(...args);
    },
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      probe.modes.push(args[2]);
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      try {
        if (probe.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, probe.delayMs));
        await fs.copyFile(...args);
      } finally {
        probe.inFlight -= 1;
      }
    },
  };
});

// Count synchronous canonicalization, which blocks the event loop once per path component.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof fs.realpathSync>) => {
      probe.realpathSyncCalls += 1;
      return fs.realpathSync(...args);
    },
    { native: fs.realpathSync.native },
  );
  const createReadStream = (...args: Parameters<typeof fs.createReadStream>) => {
    probe.reads.push(args[0]);
    return fs.createReadStream(...args);
  };
  return { ...fs, default: { ...fs, realpathSync }, realpathSync, createReadStream };
});

beforeEach(() => {
  probe.delayMs = 0;
  probe.inFlight = 0;
  probe.maxInFlight = 0;
  probe.modes = [];
  probe.realpathSyncCalls = 0;
  probe.reads = [];
});

async function packageWithFiles(count: number): Promise<{ root: string; pkg: string }> {
  const root = await createTempDir("extension-throughput-");
  const pkg = path.join(root, "package");
  await mkdir(path.join(pkg, "lib"), { recursive: true });
  await writeFile(path.join(pkg, "index.ts"), "extension");
  for (let index = 0; index < count; index += 1) {
    await writeFile(path.join(pkg, "lib", `file-${index}.js`), `module ${index}`);
  }
  return { root, pkg: await realpath(pkg) };
}

function resources(pkg: string) {
  return [
    {
      path: path.join(pkg, "index.ts"),
      enabled: true,
      metadata: { scope: "user", origin: "package", baseDir: pkg },
    },
  ];
}

it("copies extension files concurrently", async () => {
  const { root, pkg } = await packageWithFiles(24);
  probe.delayMs = 5;

  await snapshotExtensionResources(resources(pkg), path.join(root, "snapshot"));

  expect(probe.maxInFlight).toBeGreaterThan(1);
});

it("asks the filesystem for a copy-on-write clone with a plain-copy fallback", async () => {
  const { root, pkg } = await packageWithFiles(2);

  await snapshotExtensionResources(resources(pkg), path.join(root, "snapshot"));

  expect(probe.modes.length).toBeGreaterThan(0);
  for (const mode of probe.modes) {
    expect((mode ?? 0) & constants.COPYFILE_FICLONE).toBe(constants.COPYFILE_FICLONE);
    expect((mode ?? 0) & constants.COPYFILE_FICLONE_FORCE).toBe(0);
  }
});

it("does not canonicalize every staged entry synchronously", async () => {
  const small = await packageWithFiles(4);
  await snapshotExtensionResources(resources(small.pkg), path.join(small.root, "snapshot"));
  const smallCalls = probe.realpathSyncCalls;
  probe.realpathSyncCalls = 0;
  const large = await packageWithFiles(64);

  await snapshotExtensionResources(resources(large.pkg), path.join(large.root, "snapshot"));

  // The fixed cost covers the controller-owned roots; it must not grow with the package size.
  expect(probe.realpathSyncCalls).toBe(smallCalls);
});

it("lets in-flight copies finish before it reports a failure", async () => {
  const { root, pkg } = await packageWithFiles(24);
  const outside = await createTempDir("extension-throughput-outside-");
  await writeFile(path.join(outside, "escape.js"), "outside");
  await symlink(path.join(outside, "escape.js"), path.join(pkg, "lib", "a-escape.js"));
  probe.delayMs = 5;

  await expect(
    snapshotExtensionResources(resources(pkg), path.join(root, "snapshot")),
  ).rejects.toThrow("[PI_EXTENSION_RUNTIME_UNSUPPORTED]");

  expect(probe.inFlight).toBe(0);
});

it.skipIf(process.platform === "win32")(
  "validates a hit without copying or reading extension file contents",
  async () => {
    const { root, pkg } = await packageWithFiles(64);
    const payload = path.join(root, "payload");
    const packageJson = path.join(payload, "package.json");
    const plan = await planExtensionSnapshot(resources(pkg));
    const snapshot = await stageExtensionSnapshot(plan, payload);
    await writeFile(packageJson, '{"type":"module"}', { mode: 0o400 });
    probe.reads = [];
    probe.modes = [];

    await expect(validateCachedExtensionSnapshot(plan, payload, snapshot.manifest)).resolves.toBe(
      "valid",
    );
    expect(probe.modes).toEqual([]);
    expect(probe.reads).toEqual([packageJson]);
  },
);
