import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import { withExtensionCacheLock } from "./pi-extension-cache-lock.js";

const state = vi.hoisted(() => ({ retiringOwner: "" }));

vi.mock("./pi-extension-cache-format.js", async (importOriginal) => {
  const format = await importOriginal<typeof import("./pi-extension-cache-format.js")>();
  return {
    ...format,
    async readCacheText(file: string, maxBytes?: number) {
      if (file === state.retiringOwner) {
        state.retiringOwner = "";
        // Model an open descriptor whose owner unlinked it before the link-count check.
        await unlink(file);
        throw new Error("Invalid cache snapshot metadata");
      }
      return format.readCacheText(file, maxBytes);
    },
  };
});

vi.mock("./review/work-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review/work-log.js")>()),
  currentProcessInstanceIdentities: () => ["a".repeat(64)],
}));

const { createTempDir } = registerManagedTempPaths();

it.skipIf(process.platform === "win32")(
  "retries a cache lock when its previous owner removes the open marker",
  async () => {
    const root = await createTempDir("cache-lock-retiring-");
    const lock = path.join(root, "cache.lock");
    const nonce = "b".repeat(32);
    await mkdir(lock, { mode: 0o700 });
    state.retiringOwner = path.join(lock, nonce);
    await writeFile(state.retiringOwner, `${process.pid}:${nonce}:${"a".repeat(64)}\n`, {
      mode: 0o600,
    });
    await expect(
      withExtensionCacheLock(root, process.platform, async () => "acquired"),
    ).resolves.toBe("acquired");
  },
);
