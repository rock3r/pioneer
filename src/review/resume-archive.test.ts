import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyReviewResumeSession,
  createReviewResumeArchive,
  defaultReviewReportDirectory,
  defaultReviewResumeDirectory,
  findReviewResumeSessionFile,
  immutableReviewScope,
  inspectReviewResumeSessionTree,
  isResumeToken,
  loadReviewResumeArchive,
  MAX_RESUME_ARCHIVE_BYTES,
  MAX_RESUME_MANIFEST_BYTES,
  prepareDefaultReviewReportPath,
  pruneReviewResumeArchives,
  RESUME_RETENTION_MS,
  resumeArchivePath,
  retainReviewResumeArchive,
  reviewResumeArchiveHasLiveLease,
} from "./resume-archive.js";

describe("recoverable review archive", () => {
  it("counts directories toward the bounded session-entry limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-tree-"));
    try {
      await mkdir(path.join(root, "one"));
      await mkdir(path.join(root, "two"));
      await mkdir(path.join(root, "three"));

      await expect(inspectReviewResumeSessionTree(root, 2)).rejects.toThrow(
        /bounded retention limit/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares a private default report target without creating it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportPath = await prepareDefaultReviewReportPath({}, "linux", home);
    expect(
      reportPath.startsWith(path.join(home, ".local", "share", "pioneer", "reports", "review-")),
    ).toBe(true);
    await expect(stat(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.dirname(reportPath))).mode & 0o777).toBe(
      process.platform === "win32" ? (await stat(path.dirname(reportPath))).mode & 0o777 : 0o700,
    );
  });

  it("prunes generated default reports using their timestamped names", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, "linux", home);
    await mkdir(reportDirectory, { recursive: true });
    for (let index = 0; index < 101; index += 1) {
      await writeFile(
        path.join(
          reportDirectory,
          `review-20260816T000000000Z-${String(index).padStart(32, "0")}.md`,
        ),
        "report",
      );
    }
    await prepareDefaultReviewReportPath({}, "linux", home);
    expect(
      (await readdir(reportDirectory, { withFileTypes: true })).filter((entry) => entry.isFile()),
    ).toHaveLength(99);
  });

  it("uses private per-user sibling directories and UUID-only archive lookup", () => {
    expect(defaultReviewResumeDirectory({}, "linux", "/home/test")).toBe(
      "/home/test/.local/share/pioneer/review-resumes",
    );
    expect(defaultReviewReportDirectory({}, "linux", "/home/test")).toBe(
      "/home/test/.local/share/pioneer/reports",
    );
    expect(
      defaultReviewResumeDirectory(
        { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        "win32",
        "C:\\Users\\test",
      ),
    ).toBe("C:\\Users\\test\\AppData\\Local\\Pioneer\\review-resumes");
    expect(
      defaultReviewReportDirectory(
        { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        "win32",
        "C:\\Users\\test",
      ),
    ).toBe("C:\\Users\\test\\AppData\\Local\\Pioneer\\reports");
    expect(isResumeToken("not-a-token")).toBe(false);
    expect(isResumeToken("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(resumeArchivePath("/private/root", "550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/private/root/550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects relative data roots and archive roots inside actor-visible grants", async () => {
    expect(() =>
      defaultReviewResumeDirectory({ XDG_DATA_HOME: ".pioneer-data" }, "linux", "/home/test"),
    ).toThrow("Review application-data root must be absolute");
    const sourceDir = await mkdtemp(path.join(tmpdir(), "pioneer-resume-source-"));
    await expect(
      createReviewResumeArchive(
        path.join(sourceDir, "resume-data"),
        { sourceDir, prompt: "x", network: "none", piVersion: "0.84.2" },
        "550e8400-e29b-41d4-a716-446655440000",
        [sourceDir],
      ),
    ).rejects.toThrow("Review resume root overlaps an actor-visible grant");
  });

  it("rejects relative home-derived application-data roots on every platform", () => {
    expect(() => defaultReviewResumeDirectory({}, "darwin", "relative-home")).toThrow(
      "Review application-data root must be absolute",
    );
    expect(() => defaultReviewReportDirectory({}, "linux", "relative-home")).toThrow(
      "Review application-data root must be absolute",
    );
  });

  it("writes an immutable scope manifest without storing prompt or session content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(
      root,
      {
        sourceDir: "/repo",
        prompt: "private prompt",
        model: "provider/model",
        thinking: "high",
        piHomeSource: "/pi",
        piHomeIncludes: ["skills/example"],
        allowReadPaths: ["/reference"],
        allowWritePaths: [],
        network: "none",
        piVersion: "0.84.2",
      },
      "550e8400-e29b-41d4-a716-446655440000",
    );
    const manifest = JSON.parse(
      await readFile(path.join(archive.archiveDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.scope).toEqual(
      immutableReviewScope({
        sourceDir: "/repo",
        prompt: "private prompt",
        model: "provider/model",
        thinking: "high",
        piHomeSource: "/pi",
        piHomeIncludes: ["skills/example"],
        allowReadPaths: ["/reference"],
        allowWritePaths: [],
        network: "none",
        piVersion: "0.84.2",
      }),
    );
    expect(JSON.stringify(manifest)).not.toContain("private prompt");
    expect((await stat(archive.archiveDir)).mode & 0o777).toBe(
      process.platform === "win32" ? (await stat(archive.archiveDir)).mode & 0o777 : 0o700,
    );
  });

  it("rejects symlinked archive roots before reading them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const target = path.join(root, "real");
    const alias = path.join(root, "alias");
    await mkdir(target);
    await symlink(target, alias);
    await expect(
      createReviewResumeArchive(
        alias,
        {
          sourceDir: "/repo",
          prompt: "x",
          network: "none",
          piVersion: "0.84.2",
        },
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).rejects.toThrow(/symbolic link/i);
    await writeFile(path.join(target, "sentinel"), "safe");
  });

  it("retains bounded native session data and copies it into a new attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "opaque-native-session");
    await expect(
      retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE"),
    ).resolves.toMatchObject({ fileCount: 1 });
    const retainedManifest = JSON.parse(
      await readFile(path.join(archive.archiveDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(retainedManifest.state).toBe("retained");
    expect(await findReviewResumeSessionFile(archive.activeAttemptDir)).toBe(
      path.join(archive.activeAttemptDir, "session.jsonl"),
    );
    const next = await copyReviewResumeSession(archive, archive.activeAttemptDir, 2);
    expect(await readFile(path.join(next.activeAttemptDir, "session.jsonl"), "utf8")).toBe(
      "opaque-native-session",
    );
    await expect(reviewResumeArchiveHasLiveLease(next)).resolves.toBe(true);
    await retainReviewResumeArchive(next, "REVIEW_RPC_INCOMPLETE");
    await expect(reviewResumeArchiveHasLiveLease(next)).resolves.toBe(false);
  });

  it("does not copy a session while its active controller lease is live", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await expect(copyReviewResumeSession(archive, archive.activeAttemptDir, 2)).rejects.toThrow(
      "[REVIEW_RESUME_IN_USE]",
    );
  });

  it("rejects attempts beyond the bounded four-digit archive layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await expect(
      copyReviewResumeSession(archive, archive.activeAttemptDir, 10_000),
    ).rejects.toThrow("[REVIEW_RESUME_ATTEMPT_LIMIT]");
  });

  it("rejects oversized or unsafe native session trees before retention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const sessionPath = path.join(archive.activeAttemptDir, "session.jsonl");
    await writeFile(sessionPath, "session");
    await truncate(sessionPath, MAX_RESUME_ARCHIVE_BYTES + 1);
    await expect(retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      /bounded retention limit/i,
    );

    const safeRoot = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const unsafeArchive = await createReviewResumeArchive(safeRoot, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await symlink("/tmp", path.join(unsafeArchive.activeAttemptDir, "escape"));
    await expect(retainReviewResumeArchive(unsafeArchive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      /unsafe entry/i,
    );
  });

  it("rejects symlinked source attempts before a resume copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await symlink("/tmp", path.join(archive.activeAttemptDir, "escape"));
    await expect(copyReviewResumeSession(archive, archive.activeAttemptDir, 2)).rejects.toThrow(
      /unsafe entry/i,
    );
  });

  it("fails closed instead of retaining an archive with a corrupt manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await writeFile(path.join(archive.archiveDir, "manifest.json"), "not-json\n");
    await expect(retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is invalid",
    );
  });

  it("does not unlink a lease that replaced the controller's lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await writeFile(
      path.join(archive.archiveDir, "lease"),
      `${JSON.stringify({ pid: process.pid, createdAt: "replacement" })}\n`,
    );
    await expect(retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      "[REVIEW_RESUME_IN_USE]",
    );
    expect(await readFile(path.join(archive.archiveDir, "lease"), "utf8")).toContain("replacement");
  });

  it("rejects an oversized manifest before parsing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, padding: "x".repeat(MAX_RESUME_MANIFEST_BYTES) })}\n`,
    );
    await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume manifest exceeds its bounded limit",
    );
  });

  it("normalizes torn manifest and attempts metadata failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.archiveDir, "manifest.json"), "not-json\n");
    await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume manifest is invalid",
    );

    const second = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "y",
      network: "none",
      piVersion: "0.84.2",
    });
    await rm(second.attemptsDir, { recursive: true, force: true });
    await expect(loadReviewResumeArchive(root, second.token)).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume attempts directory is invalid",
    );
  });

  it("prunes stale staging and manifest temporary entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const staleTime = new Date(Date.now() - RESUME_RETENTION_MS - 1);
    const staging = path.join(archive.attemptsDir, ".attempt-crashed");
    const manifestTemp = path.join(archive.archiveDir, "manifest.json.tmp-crashed");
    await mkdir(staging);
    await writeFile(manifestTemp, "stale");
    await utimes(staging, staleTime, staleTime);
    await utimes(manifestTemp, staleTime, staleTime);
    await pruneReviewResumeArchives(root);
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(manifestTemp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes stale lease takeover temporary entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const staleLease = path.join(archive.archiveDir, "lease.stale-crashed");
    const staleTime = new Date(Date.now() - RESUME_RETENTION_MS - 1);
    await writeFile(staleLease, "stale");
    await utimes(staleLease, staleTime, staleTime);
    await pruneReviewResumeArchives(root);
    await expect(stat(staleLease)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expire an archive while any live lease holds it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, retainedAt: new Date(Date.now() - RESUME_RETENTION_MS - 1).toISOString() })}\n`,
    );
    await writeFile(
      path.join(archive.archiveDir, "lease"),
      `${JSON.stringify({ pid: process.pid, nonce: "live" })}\n`,
    );
    await pruneReviewResumeArchives(root);
    expect(await stat(archive.archiveDir)).toBeDefined();
  });

  it("does not prune a manifest-less archive while its lease is live", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.archiveDir, "manifest.json"), "broken\n");
    await pruneReviewResumeArchives(root, Date.now() + RESUME_RETENTION_MS + 1);
    expect(await stat(archive.archiveDir)).toBeDefined();
  });

  it("uses a distinct report-delivery state and prunes expired archives", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_REPORT_WRITE_FAILED");
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest.state).toBe("report_delivery_failed");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, retainedAt: new Date(Date.now() - RESUME_RETENTION_MS - 1).toISOString() })}\n`,
    );
    await pruneReviewResumeArchives(root);
    await expect(stat(archive.archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads the manifest's committed attempt instead of an uncommitted newer directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "committed.jsonl"), "committed");
    await mkdir(path.join(archive.attemptsDir, "0002"));
    await writeFile(path.join(archive.attemptsDir, "0002", "partial.jsonl"), "partial");
    await expect(loadReviewResumeArchive(root, archive.token)).resolves.toMatchObject({
      archive: { activeAttemptDir: archive.activeAttemptDir },
    });
  });

  it("replaces a crashed uncommitted attempt before atomically committing the next one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "committed");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    await mkdir(path.join(archive.attemptsDir, "0002"));
    await writeFile(path.join(archive.attemptsDir, "0002", "partial.jsonl"), "partial");
    const next = await copyReviewResumeSession(archive, archive.activeAttemptDir, 2);
    expect(await readFile(path.join(next.activeAttemptDir, "session.jsonl"), "utf8")).toBe(
      "committed",
    );
    const manifest = JSON.parse(
      await readFile(path.join(archive.archiveDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.attempt).toBe(2);
  });

  it("never deletes the committed attempt when a duplicate attempt is requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "committed");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    await expect(copyReviewResumeSession(archive, archive.activeAttemptDir, 1)).rejects.toThrow(
      "[REVIEW_RESUME_ATTEMPT_INVALID]",
    );
    expect(await readFile(path.join(archive.activeAttemptDir, "session.jsonl"), "utf8")).toBe(
      "committed",
    );
  });

  it("reclaims abandoned active archives toward the bounded retention count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    for (let index = 0; index < 11; index += 1) {
      const archive = await createReviewResumeArchive(root, {
        sourceDir: "/repo",
        prompt: `x-${index}`,
        network: "none",
        piVersion: "0.84.2",
      });
      await writeFile(
        path.join(archive.archiveDir, "lease"),
        `${JSON.stringify({ pid: 999_999_999 })}\n`,
      );
    }
    await pruneReviewResumeArchives(root);
    expect(
      (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()),
    ).toHaveLength(10);
  });

  it("rejects an expired archive at token load", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, createdAt: new Date(Date.now() - RESUME_RETENTION_MS - 1).toISOString() })}\n`,
    );
    await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume archive has expired",
    );
  });
});
