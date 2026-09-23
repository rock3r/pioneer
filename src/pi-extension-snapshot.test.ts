import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
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
  it("rejects an enabled extension placed directly in the temporary root", async () => {
    const entry = path.join(os.tmpdir(), `pioneer-enabled-temp-${process.pid}-${Date.now()}.mjs`);
    await writeFile(entry, "export {}\n");
    try {
      await expect(
        snapshotExtensionResources(
          [{ path: entry, enabled: true, metadata: { scope: "user" } }],
          await createTempDir("extension-temp-root-out-"),
        ),
      ).rejects.toThrow("dedicated directory");
    } finally {
      await rm(entry, { force: true });
    }
  });

  it("does not copy credential files nested in an extension package", async () => {
    const root = await createTempDir("extension-nested-credential-files-");
    const pkg = path.join(root, "package");
    await mkdir(pkg);
    const entry = path.join(pkg, "index.ts");
    await writeFile(entry, "extension");
    for (const name of [
      ".npmrc",
      ".netrc",
      ".env",
      ".env.local",
      ".git-credentials",
      ".yarnrc",
      ".yarnrc.yml",
    ]) {
      await writeFile(path.join(pkg, name), "secret");
    }
    const snapshot = await snapshotExtensionResources(
      [{ path: entry, enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
    );
    const staged = snapshot.paths[0];
    if (staged === undefined) throw new Error("expected a staged extension");
    const stagedPackage = path.dirname(staged);
    await expect(readFile(path.join(stagedPackage, "index.ts"), "utf8")).resolves.toBe("extension");
    for (const name of [
      ".npmrc",
      ".netrc",
      ".env",
      ".env.local",
      ".git-credentials",
      ".yarnrc",
      ".yarnrc.yml",
    ]) {
      await expect(stat(path.join(stagedPackage, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not copy a controller-only file beside an extension", async () => {
    const root = await createTempDir("extension-controller-only-");
    const pkg = path.join(root, "package");
    await mkdir(pkg);
    const entry = path.join(pkg, "index.ts");
    const answer = path.join(pkg, "answer.txt");
    await writeFile(entry, "extension");
    await writeFile(answer, "secret");
    const snapshot = await snapshotExtensionResources(
      [{ path: entry, enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
      undefined,
      undefined,
      undefined,
      [answer],
    );
    const staged = snapshot.paths[0];
    if (staged === undefined) throw new Error("expected a staged extension");
    const stagedPackage = path.dirname(staged);
    await expect(readFile(path.join(stagedPackage, "index.ts"), "utf8")).resolves.toBe("extension");
    await expect(stat(path.join(stagedPackage, "answer.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not copy a hard link to an excluded file", async () => {
    const root = await createTempDir("extension-excluded-hardlink-");
    const pkg = path.join(root, "package");
    const outside = path.join(root, "outside");
    await mkdir(pkg);
    await mkdir(outside);
    const entry = path.join(pkg, "index.ts");
    const answer = path.join(outside, "answer.txt");
    const alias = path.join(pkg, "alias.txt");
    await writeFile(entry, "extension");
    await writeFile(answer, "secret");
    await link(answer, alias);
    const snapshot = await snapshotExtensionResources(
      [{ path: entry, enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
      undefined,
      undefined,
      undefined,
      [answer],
    );
    const staged = snapshot.paths[0];
    if (staged === undefined) throw new Error("expected a staged extension");
    const stagedPackage = path.dirname(staged);
    await expect(readFile(path.join(stagedPackage, "index.ts"), "utf8")).resolves.toBe("extension");
    await expect(stat(path.join(stagedPackage, "alias.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not copy a hard link to a private Pi credential", async () => {
    const root = await createTempDir("extension-private-hardlink-");
    const agent = path.join(root, "agent");
    const pkg = path.join(root, "package");
    await mkdir(agent);
    await mkdir(pkg);
    const entry = path.join(pkg, "index.ts");
    const auth = path.join(agent, "auth.json");
    const alias = path.join(pkg, "notes.txt");
    await writeFile(entry, "extension");
    await writeFile(auth, "secret");
    await link(auth, alias);
    const snapshot = await snapshotExtensionResources(
      [{ path: entry, enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
      undefined,
      { agentDir: agent, sessionDirs: [] },
    );
    const staged = snapshot.paths[0];
    if (staged === undefined) throw new Error("expected a staged extension");
    const stagedPackage = path.dirname(staged);
    await expect(readFile(path.join(stagedPackage, "index.ts"), "utf8")).resolves.toBe("extension");
    await expect(stat(path.join(stagedPackage, "notes.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not copy a credential directory nested in an extension package", async () => {
    const root = await createTempDir("extension-nested-credential-");
    const pkg = path.join(root, "package");
    await mkdir(path.join(pkg, ".ssh"), { recursive: true });
    await mkdir(path.join(pkg, ".config", "git"), { recursive: true });
    const entry = path.join(pkg, "index.ts");
    await writeFile(entry, "extension");
    await writeFile(path.join(pkg, ".ssh", "id_rsa"), "secret");
    await writeFile(path.join(pkg, ".config", "git", "credentials"), "token");
    const snapshot = await snapshotExtensionResources(
      [{ path: entry, enabled: true, metadata: { scope: "user" } }],
      path.join(root, "snapshot"),
    );
    const staged = snapshot.paths[0];
    if (staged === undefined) throw new Error("expected a staged extension");
    const stagedPackage = path.dirname(staged);
    await expect(readFile(path.join(stagedPackage, "index.ts"), "utf8")).resolves.toBe("extension");
    await expect(stat(path.join(stagedPackage, ".ssh"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(stagedPackage, ".config", "git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "keeps a reused extension file owner-readable",
    async () => {
      const root = await createTempDir("extension-reuse-mode-");
      const pkg = path.join(root, "package");
      await mkdir(pkg);
      const entry = path.join(pkg, "index.ts");
      await writeFile(entry, "extension");
      await chmod(entry, 0o644);
      const destination = path.join(root, "snapshot");
      const first = await snapshotExtensionResources(
        [{ path: entry, enabled: true, metadata: { scope: "user" } }],
        destination,
      );
      const staged = first.paths[0];
      if (staged === undefined) throw new Error("expected a staged extension");
      expect((await stat(staged)).mode & 0o777).toBe(0o600);
      await snapshotExtensionResources(
        [{ path: entry, enabled: true, metadata: { scope: "user" } }],
        destination,
      );
      expect((await stat(staged)).mode & 0o777).toBe(0o600);
    },
  );

  it("stops when the abort signal is already aborted", async () => {
    const root = await createTempDir("extension-abort-");
    const pkg = path.join(root, "package");
    await mkdir(pkg);
    const entry = path.join(pkg, "index.ts");
    await writeFile(entry, "extension");
    const controller = new AbortController();
    controller.abort();
    await expect(
      snapshotExtensionResources(
        [{ path: entry, enabled: true, metadata: { scope: "user" } }],
        path.join(root, "snapshot"),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

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

  it("stages dependency source directories named sessions and logs with JSON resources", async () => {
    const root = await createTempDir("extension-dependency-runtime-names-");
    const agentDir = path.join(root, "agent");
    const extensions = path.join(agentDir, "extensions");
    const sdk = path.join(extensions, "node_modules", "example-sdk");
    await mkdir(path.join(sdk, "sessions"), { recursive: true });
    await mkdir(path.join(sdk, "logs"));
    await writeFile(path.join(extensions, "index.ts"), "extension");
    await writeFile(
      path.join(sdk, "package.json"),
      JSON.stringify({ name: "example-sdk", main: "index.js" }),
    );
    await writeFile(
      path.join(sdk, "index.js"),
      [
        "const sessions = require('./sessions/sessions.js');",
        "const logs = require('./logs/logger.js');",
        "const schema = require('./sessions/schema.json');",
        "module.exports = { sessions, logs, schema };",
      ].join("\n"),
    );
    await writeFile(path.join(sdk, "sessions", "sessions.js"), "module.exports = 'sessions';");
    await writeFile(path.join(sdk, "sessions", "schema.json"), '{"kind":"session-schema"}');
    await writeFile(
      path.join(sdk, "logs", "logger.js"),
      "module.exports = require('./levels.json').levels;",
    );
    await writeFile(path.join(sdk, "logs", "levels.json"), '{"levels":["info","error"]}');

    const result = await snapshotExtensionResources(
      [
        {
          path: path.join(extensions, "index.ts"),
          enabled: true,
          metadata: { scope: "user", origin: "top-level", baseDir: agentDir },
        },
      ],
      path.join(root, "snapshot"),
      undefined,
      { agentDir, sessionDirs: [] },
    );

    const stagedRequire = createRequire(result.paths[0] ?? "");
    const resolved = stagedRequire.resolve("example-sdk");
    const fromSnapshot = path.relative(
      realpathSync.native(path.join(root, "snapshot")),
      realpathSync.native(resolved),
    );
    expect(fromSnapshot).not.toMatch(/^\.\.|^[A-Za-z]:|^[\\/]/u);
    expect(stagedRequire("example-sdk")).toEqual({
      sessions: "sessions",
      logs: ["info", "error"],
      schema: { kind: "session-schema" },
    });
  });

  it("excludes private Pi session and log storage when a selected root contains it", async () => {
    const root = await createTempDir("extension-private-storage-");
    const agentDir = path.join(root, "agent");
    const logsName = process.platform === "linux" ? "logs" : "Logs";
    const history = path.join(root, "agent", "history");
    const sdk = path.join(agentDir, "node_modules", "example-sdk");
    await mkdir(path.join(agentDir, "sessions", "--project--"), { recursive: true });
    await mkdir(path.join(agentDir, logsName));
    await mkdir(history);
    await mkdir(path.join(sdk, "sessions"), { recursive: true });
    await mkdir(path.join(sdk, "logs"));
    await writeFile(path.join(agentDir, "local.ts"), "extension");
    await writeFile(path.join(agentDir, "sessions", "--project--", "run.jsonl"), "history");
    await writeFile(path.join(agentDir, logsName, "run.jsonl"), "log");
    await writeFile(path.join(agentDir, "pi-debug.log"), "debug");
    await writeFile(path.join(history, "custom.jsonl"), "custom history");
    await writeFile(path.join(sdk, "sessions", "sessions.js"), "module.exports = 'sessions';");
    await writeFile(path.join(sdk, "logs", "levels.json"), "{}");
    await writeFile(path.join(sdk, "debug.log"), "dependency file");
    if (process.platform !== "win32") {
      await symlink(path.join("..", "..", "sessions"), path.join(sdk, "linked-history"));
      await writeFile(path.join(sdk, "debug-target.txt"), "linked debug log");
      await symlink(
        path.join("node_modules", "example-sdk", "debug-target.txt"),
        path.join(agentDir, "linked-debug.log"),
      );
    }

    await expect(
      snapshotExtensionResources(
        [{ path: path.join(agentDir, "local.ts"), enabled: true, metadata: { scope: "user" } }],
        path.join(root, "snapshot"),
        undefined,
        { agentDir, sessionDirs: [history] },
      ),
    ).rejects.toThrow("Pi agent directory");
  });

  it("refuses an extension stored inside private Pi session storage", async () => {
    const root = await createTempDir("extension-inside-sessions-");
    const agentDir = path.join(root, "agent");
    await mkdir(path.join(agentDir, "sessions", "code"), { recursive: true });
    await writeFile(path.join(agentDir, "sessions", "code", "index.ts"), "extension");
    await expect(
      snapshotExtensionResources(
        [
          {
            path: path.join(agentDir, "sessions", "code", "index.ts"),
            enabled: true,
            metadata: { scope: "user" },
          },
        ],
        path.join(root, "snapshot"),
        undefined,
        { agentDir, sessionDirs: [] },
      ),
    ).rejects.toThrow("[PI_EXTENSION_RUNTIME_UNSUPPORTED]");
  });

  it("refuses an enabled entry inside session storage below a broader package root", async () => {
    const root = await createTempDir("extension-entry-inside-sessions-");
    const agentDir = path.join(root, "agent");
    await mkdir(path.join(agentDir, "sessions", "code"), { recursive: true });
    await writeFile(path.join(agentDir, "sessions", "code", "index.ts"), "extension");
    await expect(
      snapshotExtensionResources(
        [
          {
            path: path.join(agentDir, "sessions", "code", "index.ts"),
            enabled: true,
            metadata: { scope: "user", origin: "package", baseDir: agentDir },
          },
        ],
        path.join(root, "snapshot"),
        undefined,
        { agentDir, sessionDirs: [] },
      ),
    ).rejects.toThrow("Pi agent directory");
  });

  it("stages an agent-directory child directory whose name ends in .log", async () => {
    const root = await createTempDir("extension-log-named-directory-");
    const agentDir = path.join(root, "agent");
    await mkdir(path.join(agentDir, "audit.log"), { recursive: true });
    await writeFile(path.join(agentDir, "audit.log", "index.ts"), "audit extension");
    const result = await snapshotExtensionResources(
      [
        {
          path: path.join(agentDir, "audit.log", "index.ts"),
          enabled: true,
          metadata: { scope: "user" },
        },
      ],
      path.join(root, "snapshot"),
      undefined,
      { agentDir, sessionDirs: [] },
    );
    await expect(readFile(result.paths[0] ?? "", "utf8")).resolves.toBe("audit extension");
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
