import {
  chmod,
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerManagedTempPaths } from "../test/support/temp-dir.js";
import {
  readExtensionCacheManifest,
  writeExtensionCacheManifest,
} from "./pi-extension-cache-format.js";
import { validateCachedExtensionSnapshot } from "./pi-extension-cache-validation.js";
import { planExtensionSnapshot, stageExtensionSnapshot } from "./pi-extension-snapshot.js";

const { createTempDir } = registerManagedTempPaths();
const probe = vi.hoisted(() => ({
  redirectedLink: undefined as { source: string; target: string } | undefined,
  scannedFile: undefined as string | undefined,
  scans: 0,
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: (...args: Parameters<typeof fs.realpath>) =>
      args[0] === probe.redirectedLink?.source
        ? Promise.resolve(probe.redirectedLink.target)
        : fs.realpath(...args),
    open: (...args: Parameters<typeof fs.open>) => {
      if (args[0] === probe.scannedFile) probe.scans += 1;
      return fs.open(...args);
    },
  };
});

async function fixture() {
  const root = await realpath(await createTempDir("extension-cache-validation-"));
  const source = path.join(root, "extension");
  const entry = path.join(source, "index.js");
  const payload = path.join(root, "payload");
  const packageJson = path.join(payload, "package.json");
  const resources = [{ path: entry, enabled: true, metadata: { scope: "user" } }];
  const storage = { agentDir: path.join(root, "agent"), sessionDirs: [] };
  await mkdir(source);
  await writeFile(entry, "export default 'fixture';", { mode: 0o600 });
  const stage = async () => {
    const plan = await planExtensionSnapshot(resources, undefined, storage);
    const snapshot = await stageExtensionSnapshot(plan, payload);
    await writeFile(packageJson, '{"type":"module"}', { mode: 0o400 });
    return {
      plan,
      snapshot,
      validate: (currentPlan = plan) =>
        validateCachedExtensionSnapshot(currentPlan, payload, snapshot.manifest),
    };
  };
  return { root, source, entry, resources, storage, payload, packageJson, stage };
}

describe.skipIf(process.platform === "win32")("extension cache validation", () => {
  it("accepts an unchanged source and copy, including an in-tree link", async () => {
    const { source, stage } = await fixture();
    await symlink("./index.js", path.join(source, "alias.js"));
    const { validate } = await stage();
    await expect(validate()).resolves.toBe("valid");
  });

  it.each([
    ["content", async (entry: string) => writeFile(entry, "export default 'changed';")],
    ["size", async (entry: string) => writeFile(entry, "changed")],
    ["mode", async (entry: string) => chmod(entry, 0o640)],
    ["owner execute", async (entry: string) => chmod(entry, 0o700)],
    ["removed file", async (entry: string) => rm(entry)],
    ["renamed file", async (entry: string) => rename(entry, `${entry}.old`)],
  ] as const)("misses when a source file changes %s", async (_change, change) => {
    const { entry, stage } = await fixture();
    const { validate } = await stage();
    await change(entry);
    await expect(validate()).resolves.toBe("source-mismatch");
  });

  it("misses when a write restores the original size and modification time", async () => {
    const { entry, stage } = await fixture();
    const timestamp = 1_000_000_000;
    await utimes(entry, timestamp, timestamp);
    const { validate } = await stage();
    const original = await lstat(entry, { bigint: true });
    await writeFile(entry, "export default 'changed';");
    await utimes(entry, timestamp, timestamp);
    const current = await lstat(entry, { bigint: true });
    expect([current.ino, current.size, current.mtimeNs]).toEqual([
      original.ino,
      original.size,
      original.mtimeNs,
    ]);
    expect(current.ctimeNs).not.toBe(original.ctimeNs);
    await expect(validate()).resolves.toBe("source-mismatch");
  });

  it("misses when a directory gains an entry with otherwise unchanged root metadata", async () => {
    const { source, stage, payload } = await fixture();
    const { validate, snapshot, plan } = await stage();
    const newPath = path.join(source, "new");
    await mkdir(newPath);
    await writeFile(path.join(newPath, "added.js"), "fixture");
    // Simulate stored root metadata already matching, as on a filesystem with stale directory times.
    const rootMetadata = await lstat(source, { bigint: true });
    const manifest = snapshot.manifest.map((record) =>
      record.sourcePath === source ? { ...record, source: rootMetadata } : record,
    );
    await expect(validate()).resolves.toBe("source-mismatch");
    await expect(validateCachedExtensionSnapshot(plan, payload, manifest)).resolves.toBe(
      "source-mismatch",
    );
  });

  it.each([".env", ".npmrc", ".git/description"])(
    "detects new skipped paths (%s)",
    async (name) => {
      const { source, stage, root } = await fixture();
      const { validate, plan } = await stage();
      const added = path.join(source, name);
      await mkdir(path.dirname(added), { recursive: true });
      await writeFile(added, "synthetic fixture");
      await expect(validate()).resolves.toBe("source-mismatch");
      const restaged = await stageExtensionSnapshot(plan, path.join(root, "restaged"));
      expect(restaged.manifest.find((record) => record.sourcePath === added)?.staged).toBe(false);
    },
  );

  it.each(["link", "file"])("detects a staged source link replaced by a %s", async (type) => {
    const { source, stage } = await fixture();
    const alias = path.join(source, "alias.js");
    await writeFile(path.join(source, "other.js"), "synthetic alternate");
    await symlink("./index.js", alias);
    const { validate } = await stage();
    await rm(alias);
    if (type === "link") await symlink("./other.js", alias);
    else await writeFile(alias, "./index.js");
    await expect(validate()).resolves.toBe("source-mismatch");
  });

  it.each(["outside roots", "ancestor"])(
    "checks a staged link's current realpath (%s) after matching source metadata",
    async (kind) => {
      const { root, source, stage } = await fixture();
      const alias = path.join(source, "alias.js");
      await symlink("./index.js", alias);
      const { validate } = await stage();
      probe.redirectedLink = {
        source: alias,
        target: kind === "outside roots" ? path.join(root, "elsewhere") : source,
      };
      try {
        await expect(validate()).resolves.toBe("source-mismatch");
      } finally {
        probe.redirectedLink = undefined;
      }
    },
  );

  it("accepts a deliberately skipped link and misses when its canonical target changes", async () => {
    const { root, source, entry, resources, storage, payload } = await fixture();
    const privateDir = path.join(root, "synthetic-private");
    const privateTarget = path.join(privateDir, "data.txt");
    const alias = path.join(source, "alias.js");
    await mkdir(privateDir);
    await writeFile(privateTarget, "synthetic private file");
    await symlink(privateTarget, alias);
    const plan = await planExtensionSnapshot(resources, undefined, {
      ...storage,
      sessionDirs: [privateDir],
    });
    const snapshot = await stageExtensionSnapshot(plan, payload);
    await writeFile(path.join(payload, "package.json"), '{"type":"module"}', { mode: 0o400 });
    const manifestFile = path.join(root, "manifest.jsonl");
    await writeExtensionCacheManifest(manifestFile, snapshot.manifest);
    const manifest = await readExtensionCacheManifest(manifestFile);
    expect(manifest.find((record) => record.sourcePath === alias)).toMatchObject({
      staged: false,
      skippedLinkTarget: privateTarget,
    });
    await expect(validateCachedExtensionSnapshot(plan, payload, manifest)).resolves.toBe("valid");
    probe.redirectedLink = { source: alias, target: entry };
    try {
      await expect(validateCachedExtensionSnapshot(plan, payload, manifest)).resolves.toBe(
        "source-mismatch",
      );
    } finally {
      probe.redirectedLink = undefined;
    }
  });

  it("detects a link moved outside the selected roots within a previously skipped subtree", async () => {
    const { root, source, entry, stage } = await fixture();
    const linked = path.join(source, ".git", "nested");
    await mkdir(linked, { recursive: true });
    await link(entry, path.join(linked, "alias.js"));
    const { validate, plan } = await stage();
    await rename(linked, path.join(root, "moved-out"));
    await expect(validate()).resolves.toBe("source-mismatch");
    await expect(stageExtensionSnapshot(plan, path.join(root, "restaged"))).rejects.toThrow(
      "unsupported hard-link layout",
    );
  });

  it("detects a hard link that moves under a credential directory", async () => {
    const { root, source, stage } = await fixture();
    const data = path.join(source, "data.js");
    const original = path.join(source, "original-directory");
    await writeFile(data, "synthetic fixture");
    await mkdir(original);
    await link(data, path.join(original, "alias.js"));
    const { validate, plan } = await stage();
    await rename(original, path.join(source, ".ssh"));
    await expect(validate()).resolves.toBe("source-mismatch");
    const restaged = await stageExtensionSnapshot(plan, path.join(root, "restaged"));
    expect(restaged.manifest.find((record) => record.sourcePath === data)?.staged).toBe(false);
  });

  it("detects new session files and skips their multiply linked aliases inside the roots", async () => {
    const { root, source, stage } = await fixture();
    const { validate, plan } = await stage();
    const session = path.join(source, "synthetic-session.jsonl");
    const alias = path.join(source, "synthetic-session.txt");
    await writeFile(session, '{"type":"session","id":"synthetic"}\n');
    await link(session, alias);
    await expect(validate()).resolves.toBe("source-mismatch");
    const restaged = await stageExtensionSnapshot(plan, path.join(root, "restaged"));
    for (const file of [session, alias]) {
      expect(restaged.manifest.find((record) => record.sourcePath === file)?.staged).toBe(false);
    }
    await link(session, path.join(root, "external-session-link"));
    await expect(stageExtensionSnapshot(plan, path.join(root, "external"))).rejects.toThrow(
      "unsupported hard-link layout",
    );
  });

  it.each([".jsonl", "hard link"])(
    "reruns the session header check on a valid hit (%s)",
    async (kind) => {
      const { source, stage } = await fixture();
      const file = path.join(source, kind === ".jsonl" ? "data.jsonl" : "data.txt");
      await writeFile(file, '{"type":"fixture"}\n');
      if (kind === "hard link") await link(file, path.join(source, "alias.txt"));
      const { validate } = await stage();
      probe.scannedFile = file;
      probe.scans = 0;
      try {
        await expect(validate()).resolves.toBe("valid");
        expect(probe.scans).toBe(1);
      } finally {
        probe.scannedFile = undefined;
      }
    },
  );

  it.each([
    ["missing", rm],
    [
      "symlinked",
      async (file: string) => {
        const target = `${file}.moved`;
        await rename(file, target);
        await symlink(target, file);
      },
    ],
    [
      "hard linked",
      async (file: string) => link(file, path.join(path.dirname(path.dirname(file)), "hardlink")),
    ],
    [
      "changed",
      async (file: string) => {
        await chmod(file, 0o600);
        await writeFile(file, '{"type":"script"}');
        await chmod(file, 0o400);
      },
    ],
  ] as const)("rejects a %s package scope", async (_kind, change) => {
    const { packageJson, stage } = await fixture();
    const { validate } = await stage();
    await change(packageJson);
    await expect(validate()).resolves.toBe("copy-mismatch");
  });

  it.each([
    ["mode", async (file: string) => chmod(file, 0o700)],
    ["time", async (file: string) => utimes(file, 1_000_000_000, 1_000_000_000)],
  ] as const)("rejects a cached file with a changed %s", async (_kind, change) => {
    const { stage } = await fixture();
    const { validate, snapshot } = await stage();
    const [entry] = snapshot.paths;
    expect(entry).toBeDefined();
    await change(entry ?? "");
    await expect(validate()).resolves.toBe("copy-mismatch");
  });

  it("rejects unexpected entries in the generated parent directories", async () => {
    const { stage } = await fixture();
    const { validate, snapshot } = await stage();
    await writeFile(
      path.join(path.dirname(path.dirname(snapshot.paths[0] ?? "")), "package.json"),
      "{}",
    );
    await expect(validate()).resolves.toBe("copy-mismatch");
  });

  it("bypasses a generation for matching eval and repository exclusions", async () => {
    const { source, resources, storage, stage } = await fixture();
    const data = path.join(source, "fixture.jsonl");
    await writeFile(data, '{"type":"fixture"}\n');
    const { validate } = await stage();
    const evalPlan = await planExtensionSnapshot(resources, undefined, storage, [data]);
    const reviewPlan = await planExtensionSnapshot(resources, undefined, {
      ...storage,
      repositorySessionDirs: [source],
    });
    await expect(validate(evalPlan)).resolves.toBe("run-exclusions");
    await expect(validate(reviewPlan)).resolves.toBe("run-exclusions");
  });

  it("allows a cache hit when a private source was skipped and bypasses if it was staged", async () => {
    const { source, storage, resources, root, stage } = await fixture();
    const privateDir = path.join(source, "private");
    const file = path.join(privateDir, "data.txt");
    await mkdir(privateDir);
    await writeFile(file, "synthetic private file");
    const { validate } = await stage();
    const plan = await planExtensionSnapshot(resources, undefined, {
      ...storage,
      sessionDirs: [privateDir],
    });
    await expect(validate(plan)).resolves.toBe("run-exclusions");
    const filteredPayload = path.join(root, "filtered");
    const filtered = await stageExtensionSnapshot(plan, filteredPayload);
    await writeFile(path.join(filteredPayload, "package.json"), '{"type":"module"}', {
      mode: 0o400,
    });
    expect(filtered.manifest.find((record) => record.sourcePath === file)?.staged).toBe(false);
    await expect(
      validateCachedExtensionSnapshot(plan, filteredPayload, filtered.manifest),
    ).resolves.toBe("valid");
  });

  it("plans and stages against the canonical credential policy for the current environment", async () => {
    const { root, source, resources, stage } = await fixture();
    const config = path.join(source, "custom-config");
    const directory = path.join(config, "gh");
    const file = path.join(directory, "config.fixture");
    const alias = path.join(root, "config-alias");
    await mkdir(directory, { recursive: true });
    await writeFile(file, "synthetic fixture");
    await symlink(config, alias);

    const { plan, snapshot } = await stage();
    expect(snapshot.manifest.find((record) => record.sourcePath === file)?.staged).toBe(true);
    vi.stubEnv("XDG_CONFIG_HOME", alias);
    try {
      const restrictive = await planExtensionSnapshot(resources);
      expect(restrictive.credentialPathRoots).not.toEqual(plan.credentialPathRoots);
      expect(restrictive.credentialPathRoots[2]).toBe(config);
      const restaged = await stageExtensionSnapshot(restrictive, path.join(root, "other-payload"));
      expect(restaged.manifest.find((record) => record.sourcePath === file)?.staged).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
