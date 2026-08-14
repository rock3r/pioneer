import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareIsolatedPiHome } from "./pi-home.js";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ root: string; source: string; destination: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pioneer-home-"));
  const source = path.join(root, "source-agent");
  const destination = path.join(root, "run", "pi");
  await mkdir(path.join(source, "skills", "review"), { recursive: true });
  await mkdir(path.join(source, "skills", "review", "node_modules", "tmp"), { recursive: true });
  await mkdir(path.join(source, "sessions"));
  await mkdir(path.join(source, "tmp", "package", "node_modules"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "root-package"), { recursive: true });
  await mkdir(path.join(source, "npm", "managed-package"), { recursive: true });
  await mkdir(path.join(source, "git", "managed-package"), { recursive: true });
  await mkdir(path.join(source, "unknown-directory"));
  await writeFile(path.join(source, "auth.json"), '{"openai":{"type":"api_key","key":"secret"}}');
  await writeFile(path.join(source, "models.json"), "{}");
  await writeFile(path.join(source, "models-store.json"), "{}");
  await writeFile(path.join(source, "settings.json"), "{}");
  await writeFile(path.join(source, "AGENTS.md"), "agent instructions");
  await writeFile(path.join(source, "unknown-root.txt"), "unknown");
  await writeFile(path.join(source, "skills", "review", "SKILL.md"), "review skill");
  await writeFile(
    path.join(source, "skills", "review", "node_modules", "tmp", "required.js"),
    "runtime dependency",
  );
  await writeFile(path.join(source, "sessions", "old.jsonl"), "history");
  await writeFile(path.join(source, "tmp", "package", "node_modules", "transient.js"), "cache");
  await writeFile(path.join(source, "node_modules", "root-package", "index.js"), "root dependency");
  await writeFile(path.join(source, "npm", "managed-package", "index.js"), "managed npm");
  await writeFile(path.join(source, "git", "managed-package", "index.js"), "managed git");
  await writeFile(path.join(source, "unknown-directory", "secret.txt"), "unknown");
  await writeFile(path.join(source, "pi-debug.log"), "debug");
  return { root, source, destination };
}

describe("prepareIsolatedPiHome", () => {
  it("copies only the default allowlist and sanitizes review skills", async () => {
    const { source, destination } = await fixture();
    const prepared = await prepareIsolatedPiHome({
      sourceDir: source,
      destination,
      mode: "review",
    });
    const canonicalDestination = await realpath(destination);

    expect(prepared.agentDir).toBe(path.join(canonicalDestination, "agent"));
    await expect(readFile(path.join(prepared.agentDir, "auth.json"), "utf8")).resolves.toContain(
      "secret",
    );
    await expect(
      readFile(path.join(prepared.agentDir, "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toBe("review skill");
    await expect(readFile(path.join(prepared.agentDir, "models-store.json"), "utf8")).resolves.toBe(
      "{}",
    );
    await expect(readFile(path.join(prepared.agentDir, "settings.json"), "utf8")).resolves.toBe(
      "{}",
    );
    await expect(readFile(path.join(prepared.agentDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "agent instructions",
    );
    await expect(
      readFile(path.join(prepared.agentDir, "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toBe("review skill");
    await expect(
      readFile(
        path.join(prepared.agentDir, "skills", "review", "node_modules", "tmp", "required.js"),
      ),
    ).rejects.toThrow();
    await expect(readFile(path.join(prepared.agentDir, "unknown-root.txt"))).rejects.toThrow();
    await expect(
      readFile(path.join(prepared.agentDir, "unknown-directory", "secret.txt")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(prepared.agentDir, "node_modules", "root-package", "index.js")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(prepared.agentDir, "npm", "managed-package", "index.js")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(prepared.agentDir, "git", "managed-package", "index.js")),
    ).rejects.toThrow();
    await expect(readFile(path.join(prepared.agentDir, "sessions", "old.jsonl"))).rejects.toThrow();
    await expect(
      readFile(path.join(prepared.agentDir, "tmp", "package", "node_modules", "transient.js")),
    ).rejects.toThrow();
    await expect(readFile(path.join(prepared.agentDir, "pi-debug.log"))).rejects.toThrow();
    expect(prepared.environment).toEqual({
      HOME: path.join(canonicalDestination, "home"),
      TMPDIR: path.join(canonicalDestination, "tmp"),
      PI_CODING_AGENT_DIR: path.join(canonicalDestination, "agent"),
    });
  });

  it("omits every configured skill for eval snapshots", async () => {
    const { source, destination } = await fixture();
    const prepared = await prepareIsolatedPiHome({ sourceDir: source, destination, mode: "eval" });

    await expect(
      readFile(path.join(prepared.agentDir, "skills", "review", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("does not allow eval snapshots to opt Pi skills back in", async () => {
    const { source, destination } = await fixture();
    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination,
        mode: "eval",
        piHomeIncludes: ["skills"],
      }),
    ).rejects.toThrow(/only for review snapshots/i);
  });

  it("does not require missing optional root configuration files", async () => {
    const { source, destination } = await fixture();
    await unlink(path.join(source, "models-store.json"));
    await unlink(path.join(source, "settings.json"));
    await unlink(path.join(source, "AGENTS.md"));

    await expect(
      prepareIsolatedPiHome({ sourceDir: source, destination, mode: "review" }),
    ).resolves.toBeDefined();
  });

  it("rejects symbolic links that escape a supplied Pi home", async () => {
    const { root, source, destination } = await fixture();
    await writeFile(path.join(root, "outside"), "secret");
    await symlink(path.join(root, "outside"), path.join(source, "escape"));

    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination,
        mode: "review",
        piHomeIncludes: ["escape"],
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("omits a symlinked agent-bin Pi launcher because Pioneer launches host Pi", async () => {
    const { root, source, destination } = await fixture();
    const hostPi = path.join(root, "host-pi");
    await writeFile(hostPi, "#!/bin/sh\n");
    await mkdir(path.join(source, "bin"));
    await symlink(hostPi, path.join(source, "bin", "pi"));

    const prepared = await prepareIsolatedPiHome({
      sourceDir: source,
      destination,
      mode: "review",
    });
    await expect(lstat(path.join(prepared.agentDir, "bin", "pi"))).rejects.toThrow();
  });

  it("preserves symbolic links whose targets stay inside the supplied Pi home", async () => {
    const { source, destination } = await fixture();
    await symlink("models.json", path.join(source, "models-link.json"));
    const prepared = await prepareIsolatedPiHome({
      sourceDir: source,
      destination,
      mode: "review",
      piHomeIncludes: ["models-link.json"],
    });
    await expect(readFile(path.join(prepared.agentDir, "models-link.json"), "utf8")).resolves.toBe(
      "{}",
    );
  });

  it("does not charge a sparse skipped dependency fixture against the size limit", async () => {
    const { source, destination } = await fixture();
    await mkdir(path.join(source, "skills", "review", "node_modules", "huge"), { recursive: true });
    const sparsePath = path.join(source, "skills", "review", "node_modules", "huge", "sparse.bin");
    await writeFile(sparsePath, "");
    await truncate(sparsePath, 1024 * 1024 * 1024 + 1);

    await expect(
      prepareIsolatedPiHome({ sourceDir: source, destination, mode: "review" }),
    ).resolves.toBeDefined();
  });

  it("copies explicitly selected files and directories, including dependencies", async () => {
    const { source, destination } = await fixture();
    const prepared = await prepareIsolatedPiHome({
      sourceDir: source,
      destination,
      mode: "review",
      piHomeIncludes: [
        "unknown-root.txt",
        "unknown-directory",
        "node_modules",
        "node_modules/root-package",
        "npm",
        "git",
      ],
    });

    await expect(readFile(path.join(prepared.agentDir, "unknown-root.txt"), "utf8")).resolves.toBe(
      "unknown",
    );
    await expect(
      readFile(path.join(prepared.agentDir, "unknown-directory", "secret.txt"), "utf8"),
    ).resolves.toBe("unknown");
    await expect(
      readFile(path.join(prepared.agentDir, "node_modules", "root-package", "index.js"), "utf8"),
    ).resolves.toBe("root dependency");
    await expect(
      readFile(path.join(prepared.agentDir, "npm", "managed-package", "index.js"), "utf8"),
    ).resolves.toBe("managed npm");
    await expect(
      readFile(path.join(prepared.agentDir, "git", "managed-package", "index.js"), "utf8"),
    ).resolves.toBe("managed git");
  });

  it("deduplicates overlapping includes without duplicating the snapshot", async () => {
    const { source, destination } = await fixture();
    const prepared = await prepareIsolatedPiHome({
      sourceDir: source,
      destination,
      mode: "review",
      piHomeIncludes: ["unknown-directory", "unknown-directory/secret.txt"],
    });

    await expect(
      readFile(path.join(prepared.agentDir, "unknown-directory", "secret.txt"), "utf8"),
    ).resolves.toBe("unknown");
  });

  it.each([
    ["absolute", path.resolve("outside")],
    ["empty", ""],
    ["traversal", "../outside"],
    ["glob", "unknown-*"],
    ["missing", "does-not-exist"],
    ["hard exclusion", "sessions"],
  ])("rejects %s explicit includes with a stable diagnostic", async (_name, include) => {
    const { source, destination } = await fixture();
    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination,
        mode: "review",
        piHomeIncludes: [include],
      }),
    ).rejects.toThrow(/Pi home include/i);
  });

  it("requires an internal selected symlink target and reports its relative path", async () => {
    const { source, destination } = await fixture();
    await symlink(
      "../../node_modules/root-package/index.js",
      path.join(source, "skills", "review", "dependency.js"),
    );

    await expect(
      prepareIsolatedPiHome({ sourceDir: source, destination, mode: "review" }),
    ).rejects.toThrow(/node_modules\/root-package\/index\.js.*--pi-home-include/i);

    const selected = await prepareIsolatedPiHome({
      sourceDir: source,
      destination: `${destination}-selected`,
      mode: "review",
      piHomeIncludes: ["node_modules/root-package"],
    });
    await expect(
      readFile(path.join(selected.agentDir, "skills", "review", "dependency.js"), "utf8"),
    ).resolves.toBe("root dependency");
  });

  it("rejects broken, escaping, and special-file includes", async () => {
    const { root, source, destination } = await fixture();
    await symlink("missing", path.join(source, "broken"));
    await writeFile(path.join(root, "outside"), "outside");
    await symlink(path.join(root, "outside"), path.join(source, "escaping"));

    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination,
        mode: "review",
        piHomeIncludes: ["broken"],
      }),
    ).rejects.toThrow(/broken.*symbolic link/i);
    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination: `${destination}-escaping`,
        mode: "review",
        piHomeIncludes: ["escaping"],
      }),
    ).rejects.toThrow(/escaping.*symbolic link/i);
  });

  it("does not allow hard exclusions to be overridden", async () => {
    const { source, destination } = await fixture();
    await mkdir(path.join(source, ".cache", "package"), { recursive: true });
    await writeFile(path.join(source, ".cache", "package", "cache.js"), "cache");
    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination,
        mode: "review",
        piHomeIncludes: [".cache"],
      }),
    ).rejects.toThrow(/hard-excluded/i);
  });

  it.skipIf(process.platform === "win32")("rejects explicitly selected special files", async () => {
    const { source, destination } = await fixture();
    const fifo = path.join(source, "pipe");
    await execFileAsync("mkfifo", [fifo]);

    await expect(
      prepareIsolatedPiHome({
        sourceDir: source,
        destination,
        mode: "review",
        piHomeIncludes: ["pipe"],
      }),
    ).rejects.toThrow(/special file/i);
  });

  it("refuses to overwrite an existing destination", async () => {
    const { source, destination } = await fixture();
    await mkdir(destination, { recursive: true });
    await expect(
      prepareIsolatedPiHome({ sourceDir: source, destination, mode: "review" }),
    ).rejects.toThrow(/already exists/i);
  });
});
