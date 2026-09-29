import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import {
  assertDistinctToolExtensionSources,
  assertToolExtensionCount,
  resolveToolExtensionSource,
} from "./tool-extensions.js";

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

  it("rejects a tool extension named twice or nested inside another", async () => {
    const dir = await packageDir({ "index.ts": "", "nested/index.ts": "" });
    const root = await resolveToolExtensionSource(dir);
    const nested = await resolveToolExtensionSource(path.join(dir, "nested"));
    const entry = await resolveToolExtensionSource(path.join(dir, "index.ts"));
    for (const sources of [
      [root, root],
      [root, nested],
      [nested, root],
      [root, entry],
    ]) {
      expect(() => assertDistinctToolExtensionSources(sources)).toThrow(
        /PI_EXTENSION_TOOL_SOURCE_INVALID.*more than once/,
      );
    }
  });

  it("accepts distinct sibling tool extensions", async () => {
    const first = await packageDir({ "index.ts": "" });
    const second = await packageDir({ "index.js": "" });
    expect(() =>
      assertDistinctToolExtensionSources([
        { canonical: first, kind: "directory", entries: [] },
        { canonical: second, kind: "directory", entries: [] },
      ]),
    ).not.toThrow();
  });

  it("bounds the number of tool extensions before resolving any of them", () => {
    expect(() =>
      assertToolExtensionCount(Array.from({ length: 8 }, (_, i) => `/x/${i}`)),
    ).not.toThrow();
    expect(() => assertToolExtensionCount(Array.from({ length: 9 }, (_, i) => `/x/${i}`))).toThrow(
      /PI_EXTENSION_TOOL_SOURCE_INVALID.*at most 8/,
    );
  });
});
