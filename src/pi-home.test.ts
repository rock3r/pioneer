import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareIsolatedPiHome } from "./pi-home.js";

async function fixture(): Promise<{ root: string; source: string; destination: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pioneer-home-"));
  const source = path.join(root, "source-agent");
  const destination = path.join(root, "run", "pi");
  await mkdir(path.join(source, "skills", "review"), { recursive: true });
  await mkdir(path.join(source, "sessions"));
  await writeFile(path.join(source, "auth.json"), '{"openai":{"type":"api_key","key":"secret"}}');
  await writeFile(path.join(source, "models.json"), "{}");
  await writeFile(path.join(source, "skills", "review", "SKILL.md"), "review skill");
  await writeFile(path.join(source, "sessions", "old.jsonl"), "history");
  await writeFile(path.join(source, "pi-debug.log"), "debug");
  return { root, source, destination };
}

describe("prepareIsolatedPiHome", () => {
  it("creates a writable review snapshot with skills and without transient state", async () => {
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
    await expect(readFile(path.join(prepared.agentDir, "sessions", "old.jsonl"))).rejects.toThrow();
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

  it("rejects symbolic links that escape a supplied Pi home", async () => {
    const { root, source, destination } = await fixture();
    await writeFile(path.join(root, "outside"), "secret");
    await symlink(path.join(root, "outside"), path.join(source, "escape"));

    await expect(
      prepareIsolatedPiHome({ sourceDir: source, destination, mode: "review" }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("preserves symbolic links whose targets stay inside the supplied Pi home", async () => {
    const { source, destination } = await fixture();
    await symlink("models.json", path.join(source, "models-link.json"));
    const prepared = await prepareIsolatedPiHome({
      sourceDir: source,
      destination,
      mode: "review",
    });
    await expect(readFile(path.join(prepared.agentDir, "models-link.json"), "utf8")).resolves.toBe(
      "{}",
    );
  });

  it("refuses to overwrite an existing destination", async () => {
    const { source, destination } = await fixture();
    await mkdir(destination, { recursive: true });
    await expect(
      prepareIsolatedPiHome({ sourceDir: source, destination, mode: "review" }),
    ).rejects.toThrow(/already exists/i);
  });
});
