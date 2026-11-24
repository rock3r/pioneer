import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  type ExtensionCacheOptions,
  extensionCacheKey,
  prepareCachedExtensionSnapshot,
} from "./pi-extension-cache.js";
import { collectExtensionCache } from "./pi-extension-cache-leases.js";
import { validateCachedExtensionSnapshot } from "./pi-extension-cache-validation.js";
import {
  assertSameExtensionSnapshot,
  planExtensionSnapshot,
  stageExtensionSnapshot,
} from "./pi-extension-snapshot.js";
import { piRuntimeStorage } from "./pi-runtime-storage.js";
import { withPiStagedIntegrity } from "./pi-staged-integrity.js";

vi.mock("./review/work-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review/work-log.js")>()),
  currentProcessInstanceIdentities: () => ["a".repeat(64)],
  processInstanceIdentities: () => ["a".repeat(64)],
}));

describe.skipIf(process.platform === "win32")("extension snapshot cache store", () => {
  const { createTempDir } = registerManagedTempPaths();
  let base: string;
  let source: string;
  let entry: string;
  let cacheRoot: string;
  let wallTime: number;
  let bootId: string | undefined;
  const record = vi.fn();
  const takeLease = vi.fn(async () => async () => {});
  const validate = vi.fn(async () => "valid" as const);

  beforeEach(async () => {
    base = await createTempDir("cache-store-");
    source = path.join(base, "source");
    entry = path.join(source, "extension.js");
    cacheRoot = path.join(base, "cache", "pioneer", "extension-snapshots", "v1");
    await mkdir(source);
    await writeFile(entry, "export const extension = 1;\n");
    await chmod(entry, 0o700);
    await writeFile(path.join(source, "asset"), "asset\n");
    await symlink("asset", path.join(source, "link"));
    await mkdir(path.join(source, "a"));
    await writeFile(path.join(source, "a", "nested"), "a\n");
    await writeFile(path.join(source, "a-sibling"), "should sort after a/nested\n");
    // Age the observations without sleeping or modifying source ctime.
    wallTime = Date.now() + 10_000;
    bootId = "initial-boot";
    vi.clearAllMocks();
  });

  function resources() {
    return [{ path: entry, enabled: true, metadata: { scope: "user" } }];
  }

  function options(overrides: ExtensionCacheOptions = {}): ExtensionCacheOptions {
    return {
      cacheRoot,
      now: () => wallTime,
      readBootId: async () => bootId,
      record,
      takeLease,
      validate,
      ...overrides,
    };
  }

  async function prepare(name: string, overrides: ExtensionCacheOptions = {}) {
    return prepareCachedExtensionSnapshot(
      await planExtensionSnapshot(resources()),
      path.join(base, name),
      options(overrides),
    );
  }

  it.each(["before", "during"])(
    "detects a changed leased payload %s an actor run",
    async (when) => {
      const setup = await prepare("cold");
      await setup.snapshotHandle?.release();
      const hit = await prepare("warm", { validate: validateCachedExtensionSnapshot });
      const handle = hit.snapshotHandle;
      const staged = hit.paths[0];
      if (!handle || !staged) throw new Error("Expected a leased entry point");
      const change = async () => {
        await chmod(staged, 0o600);
        await writeFile(staged, "export const extension = 2;\n");
      };
      const actor = vi.fn(async () => {
        if (when === "during") await change();
        return "ok";
      });
      try {
        if (when === "before") await change();
        await expect(withPiStagedIntegrity({ extensionSnapshot: handle }, actor)).rejects.toThrow(
          "[PI_STAGED_INTEGRITY_FAILED]",
        );
        expect(actor).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      } finally {
        await handle.release();
      }
    },
  );

  it("records final modes and returns legacy-compatible snapshots on miss and hit", async () => {
    const legacy = await stageExtensionSnapshot(
      await planExtensionSnapshot(resources()),
      path.join(base, "legacy"),
    );
    const first = await prepare("miss");
    const second = await prepare("hit");
    expect(record.mock.calls.map(([value]) => value.cache)).toEqual(["miss", "hit"]);
    expect(first.snapshotHandle?.payload).toBe(second.snapshotHandle?.payload);
    expect(second.paths).toEqual(first.paths);
    expect(second.sourcePaths).toEqual(legacy.sourcePaths);
    expect(second.digest).toBe(legacy.digest);
    expect(() => assertSameExtensionSnapshot(legacy.digest, second.digest)).not.toThrow();
    expect(second.entries).toBe(legacy.entries);
    expect(second.bytes).toBe(legacy.bytes);
    const payload = first.snapshotHandle?.payload as string;
    expect(await readFile(path.join(payload, "package.json"), "utf8")).toBe('{"type":"module"}');
    expect((await lstat(first.paths[0] as string)).mode & 0o777).toBe(0o500);
    const manifest = await readFile(path.join(payload, "..", "manifest.jsonl"), "utf8");
    const entryRecord = manifest
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((item) => item.sourcePath === first.sourcePaths[0]);
    expect(entryRecord.stagedMetadata.mode).toBe(
      String((await lstat(first.paths[0] as string)).mode),
    );
    await first.snapshotHandle?.release();
    await second.snapshotHandle?.release();
  });

  it.each(["changed copy", "missing package scope after reboot"])(
    "marks a generation bad and builds a new one for a %s",
    async (damage) => {
      const validated = { validate: validateCachedExtensionSnapshot };
      const initial = await prepare("entry", validated);
      const payload = initial.snapshotHandle?.payload as string;
      await initial.snapshotHandle?.release();
      if (damage === "changed copy") {
        await chmod(initial.paths[0] as string, 0o700);
      } else {
        await rm(path.join(payload, "package.json"));
        bootId = "second-boot";
      }
      const next = await prepare("replacement", validated);
      expect(next.snapshotHandle?.payload).not.toBe(payload);
      expect(next.digest).toBe(initial.digest);
      expect(await readFile(path.join(payload, "..", "bad"), "utf8")).toBe("");
      await next.snapshotHandle?.release();
    },
  );

  it("stores no committed generation if an observed source entry was recently modified", async () => {
    wallTime = Date.now();
    const result = await prepare("racy");
    const payload = result.snapshotHandle?.payload as string;
    expect(record).toHaveBeenCalledWith({ cache: "racy", reason: "recent-source" });
    expect(
      (await readdir(path.join(cacheRoot, "entries"))).filter(
        (name) => !name.endsWith(".creating"),
      ),
    ).toEqual([]);
    expect(await readFile(result.paths[0] as string, "utf8")).toBe("export const extension = 1;\n");
    await result.snapshotHandle?.release();
    await result.snapshotHandle?.release();
    await expect(lstat(payload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rehashes once after a reboot and rejects corrupt bytes before reuse", async () => {
    const first = await prepare("before");
    const payload = first.snapshotHandle?.payload as string;
    const verified = path.join(payload, "..", "verified-boot");
    await first.snapshotHandle?.release();
    bootId = "second-boot";
    const verifiedHit = await prepare("after");
    expect(verifiedHit.snapshotHandle?.payload).toBe(payload);
    expect(await readFile(verified, "utf8")).toBe("second-boot\n");
    await verifiedHit.snapshotHandle?.release();
    bootId = undefined;
    const unknownBoot = await prepare("unknown");
    expect(unknownBoot.snapshotHandle?.payload).toBe(payload);
    expect(await readFile(verified, "utf8")).toBe("second-boot\n");
    await unknownBoot.snapshotHandle?.release();
    const staged = first.paths[0] as string;
    await chmod(staged, 0o700);
    await writeFile(staged, "export const extension = 2;\n");
    await chmod(staged, 0o500);
    const rebuilt = await prepare("rebuilt");
    expect(record.mock.calls.map(([value]) => value.cache)).toEqual(["miss", "hit", "hit", "miss"]);
    expect(rebuilt.snapshotHandle?.payload).not.toBe(payload);
    expect(rebuilt.digest).toBe(first.digest);
    expect(await readFile(path.join(payload, "..", "bad"), "utf8")).toBe("");
    await rebuilt.snapshotHandle?.release();
  });

  it.each([
    ["manifest.jsonl", (text: string) => text.trimEnd()],
    ["manifest.jsonl", (text: string) => text.slice(text.indexOf("\n") + 1)],
    ["manifest.jsonl", () => '{"staged":true,"sourcePath":"/invalid"}\n'],
    ["manifest.jsonl", (text: string) => text.replace('/source"', '/./source"')],
    ["manifest.jsonl", (text: string) => text.replace('"tree/%2F/', '"tree/%2F/../')],
    [
      "manifest.jsonl",
      (text: string) => text.replace("}\n", `,"extra":"${"界".repeat(22_000)}"}\n`),
    ],
    ["snapshot.json", (text: string) => text.trimEnd()],
    ["snapshot.json", (text: string) => text.slice(0, text.length / 2)],
    ["snapshot.json", () => '{"paths":["../outside"]}\n'],
  ])("rejects torn or malformed %s before validation", async (name, damage) => {
    const first = await prepare("first");
    const directory = path.dirname(first.snapshotHandle?.payload as string);
    await first.snapshotHandle?.release();
    const metadata = path.join(directory, name);
    await writeFile(metadata, damage(await readFile(metadata, "utf8")));
    const result = await prepare("replacement");
    expect(validate).not.toHaveBeenCalled();
    expect(result.snapshotHandle?.payload).not.toBe(first.snapshotHandle?.payload);
    expect(result.digest).toBe(first.digest);
    expect(await readFile(path.join(directory, "bad"), "utf8")).toBe("");
    await result.snapshotHandle?.release();
  });

  it("shares one generation across concurrent cold preparations", async () => {
    const { takeLease: _override, ...defaults } = options();
    const plan = await planExtensionSnapshot(resources());
    const results = await Promise.all(
      ["one", "two", "three"].map((name) =>
        prepareCachedExtensionSnapshot(plan, path.join(base, name), defaults),
      ),
    );
    expect(new Set(results.map((result) => result.snapshotHandle?.payload)).size).toBe(1);
    expect(record.mock.calls.map(([value]) => value.cache).sort()).toEqual(["hit", "hit", "miss"]);
    const payload = results[0]?.snapshotHandle?.payload as string;
    const generationId = path.basename(path.dirname(payload));
    expect(await readdir(path.join(cacheRoot, "leases", generationId))).toHaveLength(3);
    await Promise.all(results.map((result) => result.snapshotHandle?.release()));
    expect(await readdir(path.join(cacheRoot, "leases", generationId))).toEqual([]);
  });

  it("leases before asynchronous validation and releases after rejecting a hit", async () => {
    const { takeLease: _override, ...defaults } = options();
    const plan = await planExtensionSnapshot(resources());
    const initial = await prepareCachedExtensionSnapshot(
      plan,
      path.join(base, "initial"),
      defaults,
    );
    await initial.snapshotHandle?.release();
    const payload = initial.snapshotHandle?.payload as string;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const preparing = prepareCachedExtensionSnapshot(plan, path.join(base, "next"), {
      ...defaults,
      async validate() {
        entered.resolve();
        await resume.promise;
        return "copy-mismatch";
      },
    });
    try {
      await entered.promise;
      await collectExtensionCache(cacheRoot, process.platform, { now: wallTime, maxBytes: 0 });
      expect((await lstat(payload)).isDirectory()).toBe(true);
    } finally {
      resume.resolve();
    }
    const rebuilt = await preparing;
    await expect(lstat(payload)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rebuilt.digest).toBe(initial.digest);
    await rebuilt.snapshotHandle?.release();
  });

  it("does not publish a cold generation rejected by the explicit-extension coverage check", async () => {
    const acceptSnapshot = vi.fn(async () => false);
    const snapshot = await prepare("uncovered-cold", { acceptSnapshot });
    expect(snapshot.snapshotHandle).toBeUndefined();
    expect(acceptSnapshot).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({ cache: "bypass", reason: "explicit-extension" });
    expect(await readdir(path.join(cacheRoot, "entries"))).toEqual([]);
    expect(await readdir(path.join(cacheRoot, "staging"))).toEqual([]);
    expect(snapshot.paths[0]).toContain(`${path.sep}uncovered-cold${path.sep}`);
  });

  it("releases a warm generation declined by this run and leaves it available for other runs", async () => {
    const release = vi.fn(async () => {});
    const original = await prepare("unfiltered");
    const refused = await prepare("uncovered-hit", {
      acceptSnapshot: async () => false,
      takeLease: async () => release,
    });
    expect(refused.snapshotHandle).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(record).toHaveBeenLastCalledWith({ cache: "bypass", reason: "explicit-extension" });
    const reused = await prepare("later");
    expect(reused.snapshotHandle?.payload).toBe(original.snapshotHandle?.payload);
    await original.snapshotHandle?.release();
    await reused.snapshotHandle?.release();
  });

  it("uses the complete generation after a cold eval exclusion and bypasses it for later excluded runs", async () => {
    // Use a regular file with no aliases so the fixture can isolate the run-specific filter.
    const controllerOnly = path.join(source, "controller.fixture");
    await writeFile(controllerOnly, "synthetic controller file");
    const plan = await planExtensionSnapshot(resources(), undefined, undefined, [controllerOnly]);
    const prepareExcluded = (name: string) =>
      prepareCachedExtensionSnapshot(
        plan,
        path.join(base, name),
        options({ validate: validateCachedExtensionSnapshot }),
      );
    const cold = await prepareExcluded("excluded-cold");
    expect(cold.snapshotHandle?.payload).toContain(`${path.sep}staging${path.sep}`);
    expect(await readdir(path.join(cacheRoot, "entries"))).toEqual([]);
    await cold.snapshotHandle?.release();

    const full = await prepare("unrestricted");
    expect(
      await readFile(
        path.join(path.dirname(full.paths[0] as string), "controller.fixture"),
        "utf8",
      ),
    ).toBe("synthetic controller file");
    const filtered = await prepareExcluded("excluded-hit");
    expect(filtered.snapshotHandle).toBeUndefined();
    expect(record).toHaveBeenLastCalledWith({ cache: "bypass", reason: "run-exclusions" });
    await expect(
      lstat(path.join(path.dirname(filtered.paths[0] as string), "controller.fixture")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await full.snapshotHandle?.release();
  });

  it("rebuilds a generation with a missing lease timestamp", async () => {
    const { takeLease: _override, ...defaults } = options();
    const plan = await planExtensionSnapshot(resources());
    const initial = await prepareCachedExtensionSnapshot(
      plan,
      path.join(base, "initial"),
      defaults,
    );
    await initial.snapshotHandle?.release();
    const prior = path.dirname(initial.snapshotHandle?.payload as string);
    await rm(path.join(prior, "last-used"));
    const rebuilt = await prepareCachedExtensionSnapshot(
      plan,
      path.join(base, "rebuilt"),
      defaults,
    );
    expect(rebuilt.snapshotHandle).toBeDefined();
    expect(rebuilt.snapshotHandle?.payload).not.toBe(initial.snapshotHandle?.payload);
    await expect(lstat(prior)).rejects.toMatchObject({ code: "ENOENT" });
    await rebuilt.snapshotHandle?.release();
  });

  it.each(["backward", "equal", "legacy"])(
    "orders new generations with %s timestamps",
    async (clock) => {
      const { takeLease: _override, ...defaults } = options({
        validate: validateCachedExtensionSnapshot,
      });
      const plan = await planExtensionSnapshot(resources());
      const old = await prepareCachedExtensionSnapshot(plan, path.join(base, "old"), defaults);
      const oldDirectory = path.dirname(old.snapshotHandle?.payload as string);
      if (clock === "legacy") await rm(path.join(oldDirectory, "sequence"), { force: true });

      await writeFile(entry, "export const extension = 2;\n");
      const replacement = await prepareCachedExtensionSnapshot(
        plan,
        path.join(base, "new"),
        defaults,
      );
      const newDirectory = path.dirname(replacement.snapshotHandle?.payload as string);
      expect(newDirectory).not.toBe(oldDirectory);
      const newTime = new Date(1000);
      const oldTime = clock === "equal" ? newTime : new Date(2000);
      await utimes(path.join(oldDirectory, "snapshot.json"), oldTime, oldTime);
      await utimes(path.join(newDirectory, "snapshot.json"), newTime, newTime);

      await collectExtensionCache(cacheRoot, process.platform, { now: wallTime });
      expect((await lstat(oldDirectory)).isDirectory()).toBe(true);
      const hit = await prepareCachedExtensionSnapshot(plan, path.join(base, "hit"), defaults);
      expect(hit.snapshotHandle?.payload).toBe(replacement.snapshotHandle?.payload);
      await old.snapshotHandle?.release();
      await expect(lstat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await replacement.snapshotHandle?.release();
      await hit.snapshotHandle?.release();
      expect((await lstat(newDirectory)).isDirectory()).toBe(true);
    },
  );

  it("finds a fully published replacement if its first lease fails", async () => {
    const { takeLease: _override, ...defaults } = options({
      validate: validateCachedExtensionSnapshot,
    });
    const plan = await planExtensionSnapshot(resources());
    const old = await prepareCachedExtensionSnapshot(plan, path.join(base, "old"), defaults);
    const oldDirectory = path.dirname(old.snapshotHandle?.payload as string);
    await old.snapshotHandle?.release();
    const future = new Date(wallTime + 60_000);
    await utimes(path.join(oldDirectory, "snapshot.json"), future, future);
    await writeFile(entry, "export const extension = 2;\n");
    const interrupted = await prepareCachedExtensionSnapshot(plan, path.join(base, "interrupted"), {
      ...defaults,
      async takeLease(entry) {
        if (entry.directory === oldDirectory) return async () => {};
        throw new Error("Lease write interrupted after rename");
      },
    });
    expect(interrupted.snapshotHandle).toBeUndefined();
    const hit = await prepareCachedExtensionSnapshot(plan, path.join(base, "hit"), defaults);
    expect(record.mock.calls.at(-1)?.[0]).toEqual({ cache: "hit", reason: "validated" });
    expect(hit.digest).toBe(interrupted.digest);
    await hit.snapshotHandle?.release();
  });

  it("rejects a corrupt generation sequence without blocking replacement or reuse", async () => {
    const { takeLease: _override, ...defaults } = options({
      validate: validateCachedExtensionSnapshot,
    });
    const plan = await planExtensionSnapshot(resources());
    const old = await prepareCachedExtensionSnapshot(plan, path.join(base, "old"), defaults);
    const oldDirectory = path.dirname(old.snapshotHandle?.payload as string);
    await old.snapshotHandle?.release();
    await writeFile(path.join(oldDirectory, "sequence"), "torn\n");
    const replacement = await prepareCachedExtensionSnapshot(
      plan,
      path.join(base, "replacement"),
      defaults,
    );
    expect(replacement.snapshotHandle?.payload).toBeDefined();
    expect(replacement.snapshotHandle?.payload).not.toBe(old.snapshotHandle?.payload);
    const hit = await prepareCachedExtensionSnapshot(plan, path.join(base, "hit"), defaults);
    expect(hit.snapshotHandle?.payload).toBe(replacement.snapshotHandle?.payload);
    await expect(lstat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await replacement.snapshotHandle?.release();
    await hit.snapshotHandle?.release();
  });

  it("keeps staging private when either run-specific filter omits extension files", async () => {
    const logs = path.join(source, "history.jsonl");
    await writeFile(logs, '{"ordinary":"record"}\n');
    const agentDir = path.join(base, "agent");
    const excludes = await planExtensionSnapshot(resources(), undefined, undefined, [
      path.join(source, "asset"),
    ]);
    const repository = await planExtensionSnapshot(resources(), undefined, {
      agentDir,
      sessionDirs: [],
      repositorySessionDirs: [await realpath(source)],
    });
    for (const [index, plan] of [excludes, repository].entries()) {
      const run = await prepareCachedExtensionSnapshot(
        plan,
        path.join(base, `filtered-${index}`),
        options(),
      );
      expect(run.snapshotHandle?.payload).toContain(`${path.sep}staging${path.sep}`);
      await run.snapshotHandle?.release();
    }
    expect(record.mock.calls.map(([value]) => value)).toEqual([
      { cache: "bypass", reason: "run-exclusions" },
      { cache: "bypass", reason: "run-exclusions" },
    ]);
    expect(await readdir(path.join(cacheRoot, "entries"))).toEqual([]);
  });

  it("changes the key and omits content when either Pi session setting changes", async () => {
    const agentDir = path.join(base, "agent");
    const settingsFile = path.join(agentDir, "settings.json");
    const logs = path.join(source, "logs");
    await mkdir(agentDir);
    await mkdir(logs);
    await writeFile(path.join(logs, "private"), "private non-session file");
    const defaultStorage = await piRuntimeStorage(agentDir, settingsFile, {});
    const defaultPlan = await planExtensionSnapshot(resources(), undefined, defaultStorage);
    const envStorage = await piRuntimeStorage(agentDir, settingsFile, {
      PI_CODING_AGENT_SESSION_DIR: logs,
    });
    const envPlan = await planExtensionSnapshot(resources(), undefined, envStorage);
    await writeFile(settingsFile, JSON.stringify({ sessionDir: logs }));
    const settingsStorage = await piRuntimeStorage(agentDir, settingsFile, {});
    const settingsPlan = await planExtensionSnapshot(resources(), undefined, settingsStorage);
    const key = (plan: typeof defaultPlan) =>
      extensionCacheKey(plan, process.platform, process.getuid?.() ?? 0);
    expect(key(envPlan)).not.toBe(key(defaultPlan));
    expect(key(settingsPlan)).toBe(key(envPlan));
    for (const [index, plan] of [envPlan, settingsPlan].entries()) {
      const run = await prepareCachedExtensionSnapshot(
        plan,
        path.join(base, `storage-${index}`),
        options(),
      );
      await expect(
        lstat(path.join(path.dirname(run.paths[0] as string), "logs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await run.snapshotHandle?.release();
    }
  });

  it.each(["symlink", "permissive", "unsafe-parent"])("bypasses a %s cache", async (kind) => {
    const parent = path.dirname(cacheRoot);
    if (kind === "symlink") {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await symlink(source, cacheRoot);
    } else {
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      await chmod(kind === "permissive" ? cacheRoot : path.join(base, "cache"), 0o777);
    }
    const staged = await prepare("bypass");
    expect(staged.snapshotHandle).toBeUndefined();
    expect(record).toHaveBeenCalledWith({ cache: "bypass", reason: "unsafe-cache" });
    expect(await readFile(staged.paths[0] as string, "utf8")).toBe("export const extension = 1;\n");
  });

  it("bypasses a dangling cache directory without allowing a lexical overlap", async () => {
    const family = path.dirname(cacheRoot);
    await mkdir(path.dirname(family), { recursive: true, mode: 0o700 });
    await symlink(path.join(base, "missing-cache"), family);
    const staged = await prepare("dangling");
    expect(staged.snapshotHandle).toBeUndefined();
    expect(record).toHaveBeenCalledWith({ cache: "bypass", reason: "unsafe-cache" });
    await expect(prepare("overlap", { cacheRoot: path.join(source, "cache") })).rejects.toThrow(
      "PI_EXTENSION_CACHE_GRANT_OVERLAP",
    );
  });

  it("allows a stable 0755 Pioneer cache parent and keeps the snapshot hierarchy private", async () => {
    const family = path.dirname(cacheRoot);
    const pioneer = path.dirname(family);
    await mkdir(pioneer, { recursive: true, mode: 0o755 });
    await chmod(pioneer, 0o755);
    const staged = await prepare("shared-parent");
    expect(staged.snapshotHandle).toBeDefined();
    expect((await lstat(pioneer)).mode & 0o777).toBe(0o755);
    for (const directory of [family, cacheRoot, path.join(cacheRoot, "entries")]) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    await staged.snapshotHandle?.release();
  });

  it.each([
    { environment: { PIONEER_EXTENSION_CACHE: "0" } },
    { platform: "win32" },
  ] satisfies ExtensionCacheOptions[])(
    "never creates cache state when disabled",
    async (overrides) => {
      const staged = await prepare("disabled", overrides);
      expect(staged.snapshotHandle).toBeUndefined();
      await expect(lstat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("varies the key by policy, resource metadata, identity and ordered roots", async () => {
    const plan = await planExtensionSnapshot(resources());
    const original = extensionCacheKey(plan, "darwin", 1, "0.6.0");
    expect(extensionCacheKey({ ...plan, excluded: new Set([entry]) }, "darwin", 1, "0.6.0")).toBe(
      original,
    );
    expect(
      extensionCacheKey({ ...plan, repositorySessionDirs: [source] }, "darwin", 1, "0.6.0"),
    ).toBe(original);
    for (const changed of [
      extensionCacheKey(plan, "linux", 1, "0.6.0"),
      extensionCacheKey(plan, "darwin", 2, "0.6.0"),
      extensionCacheKey(plan, "darwin", 1, "0.6.1"),
      extensionCacheKey({ ...plan, selectedRoots: [] }, "darwin", 1, "0.6.0"),
      extensionCacheKey({ ...plan, agentDir: source }, "darwin", 1, "0.6.0"),
      extensionCacheKey({ ...plan, privateDirectories: [source] }, "darwin", 1, "0.6.0"),
      extensionCacheKey({ ...plan, credentialPathRoots: [source, source] }, "darwin", 1, "0.6.0"),
      extensionCacheKey(
        {
          ...plan,
          enabled: [
            {
              path: entry,
              enabled: true,
              metadata: { scope: "user", baseDir: source, origin: "package" },
            },
          ],
        },
        "darwin",
        1,
        "0.6.0",
      ),
    ])
      expect(changed).not.toBe(original);
  });
});
