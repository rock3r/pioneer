import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { resolveToolExtensionSource } from "./tool-extensions.js";

const { createTempDir } = registerManagedTempPaths();

async function packageDir(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await createTempDir("pioneer-tool-extension-"));
  const dir = path.join(root, "pi-mcp-adapter");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), contents);
  }
  return dir;
}

describe("--pi-extension source resolution (#89)", () => {
  it("resolves a package directory from its pi.extensions manifest", async () => {
    const dir = await packageDir({
      "package.json": JSON.stringify({
        name: "pi-mcp-adapter",
        pi: { extensions: ["./dist/index.js"] },
      }),
      "dist/index.js": "export default () => {};\n",
    });
    await expect(resolveToolExtensionSource(dir)).resolves.toEqual({
      canonical: dir,
      kind: "directory",
      entries: [path.join(dir, "dist", "index.js")],
    });
  });

  it("falls back to index.ts, then index.js, like Pi", async () => {
    const tsDir = await packageDir({ "index.ts": "", "index.js": "" });
    await expect(resolveToolExtensionSource(tsDir)).resolves.toMatchObject({
      entries: [path.join(tsDir, "index.ts")],
    });
    const jsDir = await packageDir({ "package.json": "{}", "index.js": "" });
    await expect(resolveToolExtensionSource(jsDir)).resolves.toMatchObject({
      entries: [path.join(jsDir, "index.js")],
    });
  });

  it("accepts a single extension file", async () => {
    const dir = await packageDir({ "adapter.ts": "" });
    await expect(resolveToolExtensionSource(path.join(dir, "adapter.ts"))).resolves.toEqual({
      canonical: path.join(dir, "adapter.ts"),
      kind: "file",
      entries: [path.join(dir, "adapter.ts")],
    });
  });

  it("rejects a directory without an extension entry", async () => {
    const dir = await packageDir({ "README.md": "" });
    await expect(resolveToolExtensionSource(dir)).rejects.toThrow(
      /PI_EXTENSION_TOOL_SOURCE_INVALID.*entry/,
    );
  });

  it("rejects a manifest entry that escapes the package directory", async () => {
    const dir = await packageDir({
      "package.json": JSON.stringify({ pi: { extensions: ["../outside.js"] } }),
    });
    await writeFile(path.join(path.dirname(dir), "outside.js"), "");
    await expect(resolveToolExtensionSource(dir)).rejects.toThrow(
      /PI_EXTENSION_TOOL_SOURCE_INVALID.*outside/,
    );
  });

  it("rejects a manifest entry that links out of the package directory", async () => {
    const dir = await packageDir({
      "package.json": JSON.stringify({ pi: { extensions: ["./linked.js"] } }),
    });
    await writeFile(path.join(path.dirname(dir), "outside.js"), "");
    await symlink(path.join(path.dirname(dir), "outside.js"), path.join(dir, "linked.js"));
    await expect(resolveToolExtensionSource(dir)).rejects.toThrow(
      /PI_EXTENSION_TOOL_SOURCE_INVALID.*outside/,
    );
  });

  it("rejects a missing path", async () => {
    const dir = await packageDir({});
    await expect(resolveToolExtensionSource(path.join(dir, "absent"))).rejects.toThrow(
      /PI_EXTENSION_TOOL_SOURCE_INVALID.*not found/,
    );
  });
});
