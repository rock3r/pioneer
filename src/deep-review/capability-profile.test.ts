import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import {
  parseCapabilityProfile,
  resolveSelectedCapabilityExtensions,
  validateCapabilityProfilePath,
  validateExtensionPath,
} from "./capability-profile.js";

describe("capability profile", () => {
  const { createTempDir } = registerManagedTempPaths();

  it("rejects extension digests that do not match file contents", async () => {
    const tempDir = await createTempDir("capability-profile-");
    const extensionPath = path.join(tempDir, "provider.ts");
    await writeFile(extensionPath, "export default function () {}\n", "utf8");
    const actualDigest = createHash("sha256")
      .update("export default function () {}\n")
      .digest("hex");

    await expect(
      validateExtensionPath(extensionPath, [], "0".repeat(actualDigest.length)),
    ).rejects.toThrow("extension digest mismatch");

    await expect(validateExtensionPath(extensionPath, [], actualDigest)).resolves.toMatch(
      /provider\.ts$/,
    );
  });

  it("parses optional digest fields on extensions", () => {
    const profile = parseCapabilityProfile({
      schemaVersion: "pioneer-capability-profile/v1",
      extensions: [{ id: "ext-a", path: "/opt/ext.ts", digest: "abc123" }],
    });
    expect(profile.extensions[0]?.digest).toBe("abc123");
  });

  it("rejects capability profiles inside the reviewed source tree", async () => {
    const tempDir = await createTempDir("capability-profile-source-");
    const profilePath = path.join(tempDir, "profile.json");
    await writeFile(profilePath, "{}", "utf8");
    await expect(validateCapabilityProfilePath(profilePath, [tempDir])).rejects.toThrow(
      "capability profile path overlaps forbidden grant",
    );
  });

  it("requires digests when resolving selected extensions", async () => {
    const sourceDir = await createTempDir("capability-profile-source-forbid-");
    const profileDir = await createTempDir("capability-profile-outside-");
    const extensionPath = path.join(profileDir, "provider.ts");
    await writeFile(extensionPath, "export default function () {}\n", "utf8");
    const profilePath = path.join(profileDir, "profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        schemaVersion: "pioneer-capability-profile/v1",
        extensions: [{ id: "ext-a", path: extensionPath }],
      }),
      "utf8",
    );

    await expect(
      resolveSelectedCapabilityExtensions(
        {
          schemaVersion: "pioneer-deep-review-config/v1",
          council: [],
          president: { id: "p", model: "p/p", independenceGroup: "gp" },
          capabilityProfile: { path: profilePath, extensionIds: ["ext-a"] },
        },
        [sourceDir],
      ),
    ).rejects.toThrow("extension digest is required");
  });
});
