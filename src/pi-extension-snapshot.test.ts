import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  assertSameExtensionSnapshot,
  extensionPathsWithCapabilities,
  snapshotExtensionResources,
} from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();

describe("extension snapshots", () => {
  it("loads capability extensions already present in a snapshot only once", async () => {
    const root = await createTempDir("extension-capability-duplicate-");
    const pkg = path.join(root, "package");
    await mkdir(pkg);
    const entry = path.join(pkg, "index.ts");
    await writeFile(entry, "extension");
    const snapshot = await snapshotExtensionResources(
      [{ path: entry, enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
    );
    const canonical = await (await import("node:fs/promises")).realpath(entry);
    expect(extensionPathsWithCapabilities(snapshot, [canonical, canonical])).toEqual(
      snapshot.paths,
    );
    expect(extensionPathsWithCapabilities(snapshot, [path.join(root, "other.ts")])).toEqual([
      ...snapshot.paths,
      path.join(root, "other.ts"),
    ]);
  });
  it.skipIf(process.platform === "win32")("keeps colon-containing roots distinct", async () => {
    const root = await createTempDir("extension-root-collision-");
    const resources = [];
    for (const name of ["a:b", "ab"]) {
      const pkg = path.join(root, name);
      await mkdir(pkg);
      const entry = path.join(pkg, "index.ts");
      await writeFile(entry, name);
      resources.push({ path: entry, enabled: true, metadata: { scope: "user" } });
    }
    const snapshot = await snapshotExtensionResources(resources, path.join(root, "snapshot"));
    expect(await Promise.all(snapshot.paths.map((entry) => readFile(entry, "utf8")))).toEqual([
      "a:b",
      "ab",
    ]);
  });
  it.skipIf(process.platform === "win32")(
    "preserves internal dependency links in the staged layout",
    async () => {
      const root = await createTempDir("extension-links-");
      const pkg = path.join(root, "package");
      await mkdir(pkg);
      await writeFile(path.join(pkg, "index.ts"), "extension");
      await writeFile(path.join(pkg, "real.js"), "dependency");
      await symlink("real.js", path.join(pkg, "alias.js"));
      const result = await snapshotExtensionResources(
        [
          {
            path: path.join(pkg, "index.ts"),
            enabled: true,
            metadata: { scope: "user", origin: "package", baseDir: pkg },
          },
        ],
        path.join(root, "snapshot"),
      );
      const alias = path.join(path.dirname(result.paths[0] ?? ""), "alias.js");
      expect(await readlink(alias)).toBe("real.js");
      expect(await readFile(alias, "utf8")).toBe("dependency");
    },
  );
  it("resumes identical snapshots and refuses changed dependency bytes", async () => {
    const root = await createTempDir("extension-resume-digest-");
    const pkg = path.join(root, "package");
    await mkdir(pkg);
    await writeFile(path.join(pkg, "index.ts"), "extension");
    await writeFile(path.join(pkg, "helper.js"), "original");
    const resources = [
      {
        path: path.join(pkg, "index.ts"),
        enabled: true,
        metadata: { scope: "user", origin: "package", baseDir: pkg },
      },
    ];
    const first = await snapshotExtensionResources(resources, path.join(root, "first"));
    const same = await snapshotExtensionResources(resources, path.join(root, "same"));
    expect(() => assertSameExtensionSnapshot(first.digest, same.digest)).not.toThrow();
    await writeFile(path.join(pkg, "helper.js"), "changed");
    const changed = await snapshotExtensionResources(resources, path.join(root, "changed"));
    expect(() => assertSameExtensionSnapshot(first.digest, changed.digest)).toThrow(
      "[REVIEW_RESUME_EXTENSIONS_CHANGED]",
    );
    expect(() => assertSameExtensionSnapshot(undefined, "0".repeat(64))).not.toThrow();
    expect(() => assertSameExtensionSnapshot(undefined, first.digest)).toThrow(
      "[REVIEW_RESUME_EXTENSIONS_CHANGED]",
    );
  });
  it("retains parent node_modules resolution for a local file extension", async () => {
    const root = await createTempDir("local-parent-dependency-");
    const extensions = path.join(root, "extensions");
    const dependency = path.join(root, "node_modules", "dependency");
    await mkdir(extensions);
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(extensions, "index.ts"), "extension");
    await writeFile(path.join(dependency, "index.js"), "dependency");
    const result = await snapshotExtensionResources(
      [{ path: path.join(extensions, "index.ts"), enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
    );
    expect(
      await readFile(
        path.join(
          path.dirname(result.paths[0] ?? ""),
          "..",
          "node_modules",
          "dependency",
          "index.js",
        ),
        "utf8",
      ),
    ).toBe("dependency");
  });
  it.skipIf(process.platform === "win32")(
    "rejects a dependency link into unrelated private files",
    async () => {
      const root = await createTempDir("extension-escape-");
      const pkg = path.join(root, "package");
      await mkdir(pkg);
      await writeFile(path.join(pkg, "index.ts"), "extension");
      await writeFile(path.join(root, "private.txt"), "private");
      await symlink(path.join(root, "private.txt"), path.join(pkg, "escape"));
      await expect(
        snapshotExtensionResources(
          [
            {
              path: path.join(pkg, "index.ts"),
              enabled: true,
              metadata: { scope: "user", origin: "package", baseDir: pkg },
            },
          ],
          path.join(root, "snapshot"),
        ),
      ).rejects.toThrow("[PI_EXTENSION_RUNTIME_UNSUPPORTED]");
    },
  );
  it("preserves npm hoisted dependencies beside the installed package", async () => {
    const root = await createTempDir("npm-extensions-");
    const modules = path.join(root, "node_modules");
    const pkg = path.join(modules, "extension");
    await mkdir(pkg, { recursive: true });
    await mkdir(path.join(modules, "dependency"));
    await writeFile(path.join(pkg, "index.js"), "extension");
    await writeFile(path.join(modules, "dependency", "index.js"), "dependency");
    const result = await snapshotExtensionResources(
      [
        {
          path: path.join(pkg, "index.js"),
          enabled: true,
          metadata: { scope: "user", origin: "package", baseDir: pkg },
        },
      ],
      path.join(root, "snapshot"),
    );
    expect(
      await readFile(
        path.join(path.dirname(result.paths[0] ?? ""), "..", "dependency", "index.js"),
        "utf8",
      ),
    ).toBe("dependency");
  });
  it("copies enabled package code, dependencies and assets but excludes disabled and project resources", async () => {
    const root = await createTempDir("extensions-");
    const pkg = path.join(root, "package");
    await mkdir(path.join(pkg, "node_modules", "dependency"), { recursive: true });
    await writeFile(path.join(pkg, "index.ts"), "export default () => {};");
    await writeFile(path.join(pkg, "asset.txt"), "asset");
    await writeFile(path.join(pkg, "node_modules", "dependency", "index.js"), "dependency");
    const result = await snapshotExtensionResources(
      [
        {
          path: path.join(pkg, "index.ts"),
          enabled: true,
          metadata: { scope: "user", origin: "package", baseDir: pkg },
        },
        {
          path: path.join(root, "missing-disabled.ts"),
          enabled: false,
          metadata: { scope: "user" },
        },
        {
          path: path.join(root, "missing-project.ts"),
          enabled: true,
          metadata: { scope: "project" },
        },
      ],
      path.join(root, "snapshot"),
    );
    expect(result.paths).toHaveLength(1);
    const staged = path.dirname(result.paths[0] ?? "");
    expect(await readFile(path.join(staged, "asset.txt"), "utf8")).toBe("asset");
    expect(
      await readFile(path.join(staged, "node_modules", "dependency", "index.js"), "utf8"),
    ).toBe("dependency");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(path.join(pkg, "asset.txt"), "changed");
    expect(await readFile(path.join(staged, "asset.txt"), "utf8")).toBe("asset");
  });

  it("stages local-file siblings once without loading extension code", async () => {
    const root = await createTempDir("local-extensions-");
    const extensions = path.join(root, "extensions");
    await mkdir(extensions);
    await writeFile(path.join(extensions, "one.ts"), "throw new Error('must not execute');");
    await writeFile(path.join(extensions, "helper.js"), "helper");
    const result = await snapshotExtensionResources(
      [
        {
          path: path.join(extensions, "one.ts"),
          enabled: true,
          metadata: { scope: "user", origin: "top-level" },
        },
      ],
      path.join(root, "snapshot"),
    );
    expect(
      await readFile(path.join(path.dirname(result.paths[0] ?? ""), "helper.js"), "utf8"),
    ).toBe("helper");
  });
});
