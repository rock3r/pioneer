import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import type { ExtensionCacheEntry } from "./pi-extension-cache.js";
import {
  collectExtensionCache,
  startExtensionCacheBackgroundDeletion,
  takeExtensionCacheLease,
} from "./pi-extension-cache-leases.js";
import { withExtensionCacheLock } from "./pi-extension-cache-lock.js";

const identity = vi.hoisted(() => vi.fn<() => readonly string[] | undefined>());
vi.mock("./review/work-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review/work-log.js")>()),
  currentProcessInstanceIdentities: () => ["a".repeat(64)],
  processInstanceIdentities: identity,
}));

describe.skipIf(process.platform === "win32")("extension snapshot leases and collection", () => {
  const { createTempDir } = registerManagedTempPaths();
  const platform = process.platform;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const key = "1".repeat(64);
  const deadPid = 2 ** 31 - 1;
  let root: string;

  beforeEach(async () => {
    root = await createTempDir("cache-leases-");
    for (const name of ["entries", "leases", "staging", "trash"]) {
      await mkdir(path.join(root, name), { mode: 0o700 });
    }
    identity.mockReset().mockReturnValue(["a".repeat(64)]);
  });

  async function generation(
    digit: string,
    createdAt: number,
    usedAt: number,
    bytes = 500,
    cacheKey = key,
  ): Promise<ExtensionCacheEntry> {
    const id = digit.repeat(32);
    const directory = path.join(root, "entries", cacheKey, id);
    const payload = path.join(directory, "payload");
    await mkdir(payload, { recursive: true, mode: 0o700 });
    const metadata = path.join(directory, "snapshot.json");
    await writeFile(metadata, `${JSON.stringify({ bytes, createdAt })}\n`, { mode: 0o600 });
    await writeFile(path.join(directory, "manifest.jsonl"), "", { mode: 0o600 });
    await writeFile(path.join(directory, "verified-boot"), "boot\n", { mode: 0o600 });
    await writeFile(path.join(payload, "package.json"), '{"type":"module"}', { mode: 0o400 });
    const lastUsed = path.join(directory, "last-used");
    await writeFile(lastUsed, "", { mode: 0o600 });
    await utimes(metadata, new Date(createdAt), new Date(createdAt));
    await utimes(lastUsed, new Date(usedAt), new Date(usedAt));
    return { root, directory, payload, key: cacheKey, id };
  }

  function lease(entry: ExtensionCacheEntry) {
    return withExtensionCacheLock(root, platform, () =>
      takeExtensionCacheLease(entry, platform, () => now),
    );
  }

  async function writeLease(entry: ExtensionCacheEntry, nonce: string, pid: number, start: string) {
    const directory = path.join(root, "leases", entry.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, `${nonce}.json`),
      `${JSON.stringify({ owner: `${pid}:${nonce}:${start}\n` })}\n`,
      { mode: 0o600 },
    );
  }

  it("keeps a leased generation even when it is bad, superseded and over budget", async () => {
    const old = await generation("a", now - 16 * day, now - 15 * day);
    const release = await lease(old);
    expect((await lstat(path.join(old.directory, "last-used"))).mtimeMs).toBeCloseTo(now, -1);
    await generation("b", now, now);
    await writeFile(path.join(old.directory, "bad"), "", { mode: 0o600 });
    await collectExtensionCache(root, platform, { now, maxBytes: 0 });
    expect((await lstat(old.directory)).isDirectory()).toBe(true);
    await release();
    await release();
    await expect(lstat(old.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(root, "trash"))).toHaveLength(2);
    await startExtensionCacheBackgroundDeletion(root, platform, now).finished;
    expect(await readdir(path.join(root, "trash"))).toEqual([]);
  });

  it("keeps all live owners and evicts the least recently used unleased generations", async () => {
    const oldest = await generation("a", now - 10_000, now - 10_000, 500);
    const recent = await generation("b", now - 9_000, now - 9_000, 500, "2".repeat(64));
    const active = await generation("c", now - 12_000, now - 12_000, 500, "3".repeat(64));
    const first = await lease(active);
    const second = await lease(active);
    await first();
    await collectExtensionCache(root, platform, { now, maxBytes: 1300 });
    await expect(lstat(oldest.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(recent.directory)).isDirectory()).toBe(true);
    expect(await readdir(path.join(root, "leases", active.id))).toHaveLength(1);
    await second();
  });

  it("counts persisted manifest bytes towards the apparent-size budget", async () => {
    const entry = await generation("a", now, now, 0);
    await writeFile(path.join(entry.directory, "manifest.jsonl"), "x".repeat(500));
    await collectExtensionCache(root, platform, { now, maxBytes: 400 });
    await expect(lstat(entry.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims leases only when the PID is absent or live with a different start identity", async () => {
    const dead = await generation("a", now - 15 * day, now - 15 * day);
    const reused = await generation("b", now - 15 * day, now - 15 * day);
    await writeLease(dead, "a".repeat(32), deadPid, "a".repeat(64));
    await writeLease(reused, "b".repeat(32), process.pid, "b".repeat(64));
    await collectExtensionCache(root, platform, { now });
    await expect(lstat(dead.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(reused.directory)).rejects.toMatchObject({ code: "ENOENT" });
    const undecided = await generation("d", now - day, now - day);
    await writeLease(undecided, "d".repeat(32), process.pid, "b".repeat(64));
    identity.mockReturnValue(undefined);
    await collectExtensionCache(root, platform, { now: now + 16 * day });
    expect((await lstat(undecided.directory)).isDirectory()).toBe(true);
    expect(
      await readFile(path.join(root, "leases", undecided.id, `${"d".repeat(32)}.json`), "utf8"),
    ).toContain(String(process.pid));
  });

  it("preserves another process's generation until that process exits", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const started = once(child, "spawn");
    const closed = once(child, "close");
    let active: ExtensionCacheEntry;
    try {
      await started;
      active = await generation("a", now - 15 * day, now - 15 * day);
      if (child.pid === undefined) throw new Error("Lease fixture process has no PID");
      await writeLease(active, "a".repeat(32), child.pid, "a".repeat(64));
      await collectExtensionCache(root, platform, { now });
      expect((await lstat(active.directory)).isDirectory()).toBe(true);
    } finally {
      child.kill();
      await closed;
    }
    await collectExtensionCache(root, platform, { now });
    await expect(lstat(active.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims old staging and creation locks only if their owners are gone", async () => {
    const stale = now - (60 * 60 * 1000 + 60_000);
    const dead = "a".repeat(32);
    const live = "b".repeat(32);
    for (const [nonce, pid] of [
      [dead, deadPid],
      [live, process.pid],
    ] as const) {
      const staging = path.join(root, "staging", nonce);
      await mkdir(staging, { mode: 0o700 });
      await writeFile(path.join(staging, "owner"), `${pid}:${nonce}:${"a".repeat(64)}\n`, {
        mode: 0o600,
      });
      await utimes(staging, new Date(stale), new Date(stale));
    }
    const lock = path.join(root, "entries", `${key}.creating`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(path.join(lock, dead), `${deadPid}:${dead}:${"a".repeat(64)}\n`, {
      mode: 0o600,
    });
    await startExtensionCacheBackgroundDeletion(root, platform, now).finished;
    expect(await readdir(path.join(root, "staging"))).toEqual([live]);
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
