import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { piPackageHostsAuthAdapter, piPackageHostsExtensionRuntime } from "./pi-extension-host.js";
import { isSensitiveCredentialPath } from "./runner.js";

const { createTempDir } = registerManagedTempPaths();

describe("Pi package runtime hosting", () => {
  it("requires the auth worker modules before brokering OAuth", async () => {
    const root = await createTempDir("pioneer-pi-auth-host-");
    const core = path.join(root, "dist", "core");
    await mkdir(core, { recursive: true });
    for (const name of [
      "cli.js",
      "core/package-manager.js",
      "core/resource-loader.js",
      "core/settings-manager.js",
    ]) {
      await writeFile(path.join(root, "dist", name), "export {}\n");
    }
    await expect(piPackageHostsExtensionRuntime(root)).resolves.toBe(true);
    await expect(piPackageHostsAuthAdapter(root)).resolves.toBe(false);

    await writeFile(path.join(root, "dist", "cli.js"), "export {}\n");
    await writeFile(path.join(core, "auth-storage.js"), "export {}\n");
    await writeFile(path.join(core, "http-dispatcher.js"), "export {}\n");
    await expect(piPackageHostsAuthAdapter(root)).resolves.toBe(false);
    await writeFile(path.join(core, "model-registry.js"), "export {}\n");
    await expect(piPackageHostsAuthAdapter(root)).resolves.toBe(true);
  });

  it("folds credential directory names on case-insensitive platforms", () => {
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.ssh${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    const mixed = `${path.sep}Users${path.sep}user${path.sep}.SSH${path.sep}provider.mjs`;
    expect(isSensitiveCredentialPath(mixed)).toBe(process.platform !== "linux");
  });
});
