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
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.pki${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.cargo${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.gem${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.oci${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.pulumi${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${path.sep}home${path.sep}user${path.sep}.terraform.d${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    const mixed = `${path.sep}Users${path.sep}user${path.sep}.SSH${path.sep}provider.mjs`;
    expect(isSensitiveCredentialPath(mixed)).toBe(process.platform !== "linux");
    const home = `${path.sep}home${path.sep}user`;
    expect(isSensitiveCredentialPath(`${home}${path.sep}.config${path.sep}provider.mjs`)).toBe(
      true,
    );
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}my-extension${path.sep}provider.mjs`,
      ),
    ).toBe(false);
    expect(
      isSensitiveCredentialPath(`${home}${path.sep}.config${path.sep}git${path.sep}provider.mjs`),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}pypoetry${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(`${home}${path.sep}.config${path.sep}helm${path.sep}provider.mjs`),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(`${home}${path.sep}.config${path.sep}sops${path.sep}provider.mjs`),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}rclone${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}containers${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}glab-cli${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(`${home}${path.sep}.config${path.sep}doctl${path.sep}provider.mjs`),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.mozilla${path.sep}firefox${path.sep}profile${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}google-chrome${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}chromium${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}microsoft-edge${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Application Support${path.sep}Google${path.sep}Chrome${path.sep}profile${path.sep}provider.mjs`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Application Support${path.sep}Chromium${path.sep}profile${path.sep}provider.mjs`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.config${path.sep}BraveSoftware${path.sep}Brave-Browser${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Application Support${path.sep}BraveSoftware${path.sep}Brave-Browser${path.sep}profile${path.sep}provider.mjs`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Application Support${path.sep}Microsoft Edge${path.sep}profile${path.sep}provider.mjs`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Safari${path.sep}provider.mjs`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Containers${path.sep}com.apple.Safari${path.sep}Data${path.sep}provider.mjs`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(`${home}${path.sep}.local${path.sep}share${path.sep}provider.mjs`),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.local${path.sep}share${path.sep}keyrings${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.local${path.sep}share${path.sep}pioneer${path.sep}review-resumes${path.sep}session.json`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.local${path.sep}state${path.sep}pioneer${path.sep}provider.mjs`,
      ),
    ).toBe(true);
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}Application Support${path.sep}Pioneer${path.sep}review-resumes${path.sep}session.json`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}AppData${path.sep}Local${path.sep}Pioneer${path.sep}review-resumes${path.sep}session.json`,
      ),
    ).toBe(process.platform !== "linux");
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}.local${path.sep}share${path.sep}my-extension${path.sep}provider.mjs`,
      ),
    ).toBe(false);
    expect(isSensitiveCredentialPath(`${home}${path.sep}Library${path.sep}provider.mjs`)).toBe(
      process.platform !== "linux",
    );
    expect(
      isSensitiveCredentialPath(
        `${home}${path.sep}Library${path.sep}my-extension${path.sep}provider.mjs`,
      ),
    ).toBe(false);
    for (const folder of ["Documents", "Desktop", "Downloads"]) {
      expect(isSensitiveCredentialPath(`${home}${path.sep}${folder}${path.sep}provider.mjs`)).toBe(
        true,
      );
      expect(
        isSensitiveCredentialPath(
          `${home}${path.sep}${folder}${path.sep}my-extension${path.sep}provider.mjs`,
        ),
      ).toBe(false);
    }
  });
});
