import { expect, it, vi } from "vitest";
import { snapshotExtensionResources } from "./pi-extension-snapshot.js";

const fixture = vi.hoisted(() => {
  // Use fixed absolute POSIX paths and modes independent of the host OS or temporary directory.
  const source = "/golden-pioneer/extension";
  const nodes = new Map<string, { readonly mode: number; readonly content?: string }>([
    [source, { mode: 0o40755 }],
    [`${source}/lib`, { mode: 0o40755 }],
    [`${source}/lib/dep.ts`, { mode: 0o100644, content: "export const answer = 42;\n" }],
    [`${source}/review.ts`, { mode: 0o100644, content: "export default 'review';\n" }],
    [`${source}/tool.ts`, { mode: 0o100755, content: "#!/usr/bin/env node\n" }],
  ]);
  return { source, nodes };
});

vi.mock("node:path", async (original) => {
  const path = await original<typeof import("node:path")>();
  return { ...path, default: path.posix };
});

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, default: { ...os, homedir: () => "/home/golden-pioneer" } };
});

// The fixture presents the same filesystem to staging on every host. No digest call is mocked.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const get = (file: string) => {
    const entry = fixture.nodes.get(file);
    if (entry === undefined)
      throw Object.assign(new Error("Missing fixture entry"), { code: "ENOENT" });
    return entry;
  };
  const names = (directory: string) =>
    // Present the entries out of order to exercise sorted digest traversal.
    [...fixture.nodes.keys()]
      .filter((name) => name.startsWith(`${directory}/`))
      .map((name) => name.slice(directory.length + 1))
      .filter((name) => !name.includes("/"))
      .reverse();
  const stats = async (file: string, options?: { readonly bigint?: boolean }) => {
    const entry = get(file);
    const value = (number: number) => (options?.bigint === true ? BigInt(number) : number);
    return {
      dev: value(1),
      ino: value([...fixture.nodes.keys()].indexOf(file) + 1),
      size: value(Buffer.byteLength(entry.content ?? "")),
      mode: value(entry.mode),
      mtimeMs: value(1),
      mtimeNs: 1_000_000n,
      ctimeNs: 1_000_000n,
      nlink: value(1),
      isDirectory: () => entry.content === undefined,
      isFile: () => entry.content !== undefined,
      isSymbolicLink: () => false,
    };
  };
  return {
    ...fs,
    realpath: async (file: string) => file,
    lstat: stats,
    stat: stats,
    opendir: async (directory: string) => ({
      async *[Symbol.asyncIterator]() {
        for (const name of names(directory)) yield { name };
      },
    }),
    readdir: async (directory: string) => names(directory),
    mkdir: async (directory: string) => {
      fixture.nodes.set(directory, { mode: 0o40700 });
    },
    copyFile: async (source: string, destination: string) => {
      fixture.nodes.set(destination, get(source));
    },
    chmod: async (file: string, mode: number) => {
      const entry = get(file);
      fixture.nodes.set(file, { ...entry, mode: (entry.mode & ~0o777) | mode });
    },
    readFile: async (file: string) => Buffer.from(get(file).content ?? ""),
  };
});

it("preserves the 0.4.9 digest for the same tree at different staging destinations", async () => {
  const resources = ["tool.ts", "review.ts"].map((name) => ({
    path: `${fixture.source}/${name}`,
    enabled: true,
    metadata: { scope: "user" },
  }));

  const first = await snapshotExtensionResources(resources, "/run/snapshot");
  const relocated = await snapshotExtensionResources(resources, "/expanded/cache/root/payload");

  // Recorded by running this fixture against v0.4.9 (06e8b2ffd5ce).
  expect(first.digest).toBe("493bc4265e22f4372ae959a96695b4c3356edf8802c6628f218d95144b95805e");
  expect(relocated.digest).toBe(first.digest);
});
