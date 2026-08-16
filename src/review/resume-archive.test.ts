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
import { reserveReviewReport } from "./report-output.js";
import {
  copyReviewResumeSession,
  createReviewResumeArchive,
  defaultReviewReportDirectory,
  defaultReviewResumeDirectory,
  findReviewResumeSessionFile,
  immutableReviewScope,
  inspectReviewResumeSessionTree,
  isResumeToken,
  leaseReviewResumeArchive,
  loadReviewResumeArchive,
  MAX_RESUME_ARCHIVE_BYTES,
  MAX_RESUME_MANIFEST_BYTES,
  prepareDefaultReviewReportPath,
  prepareValidatedDefaultReviewReportPath,
  pruneInactiveReviewResumeArchive,
  pruneReviewResumeArchives,
  RESUME_RETENTION_MS,
  releaseLeasedReviewResumeArchive,
  resumeArchivePath,
  retainReviewResumeArchive,
  reviewResumeArchiveHasLiveLease,
  rollbackReviewResumeArchiveToPriorAttempt,
  statReviewResumeArchiveCandidate,
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
    const reportPath = await prepareDefaultReviewReportPath({}, process.platform, home);
    expect(reportPath.startsWith(defaultReviewReportDirectory({}, process.platform, home))).toBe(
      true,
    );
    await expect(stat(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.dirname(reportPath))).mode & 0o777).toBe(
      process.platform === "win32" ? (await stat(path.dirname(reportPath))).mode & 0o777 : 0o700,
    );
  });

  it("validates the default report target before creating or pruning its directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);

    await expect(
      prepareValidatedDefaultReviewReportPath(
        async () => {
          throw new Error("actor-visible report target");
        },
        {},
        process.platform,
        home,
      ),
    ).rejects.toThrow("actor-visible report target");
    await expect(stat(reportDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes generated default reports using their timestamped names", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
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
    await prepareDefaultReviewReportPath({}, process.platform, home);
    expect(
      (await readdir(reportDirectory, { withFileTypes: true })).filter((entry) => entry.isFile()),
    ).toHaveLength(99);
  });

  it("does not prune an active default report reservation", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
    await mkdir(reportDirectory, { recursive: true });
    const activeReport = path.join(
      reportDirectory,
      "review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md",
    );
    await reserveReviewReport(activeReport);
    for (let index = 0; index < 101; index += 1) {
      await writeFile(
        path.join(
          reportDirectory,
          `review-20260816T000000000Z-${String(index).padStart(32, "0")}.md`,
        ),
        "report",
      );
    }

    await prepareDefaultReviewReportPath({}, process.platform, home);

    expect(await readFile(activeReport, "utf8")).toContain("PIONEER_REPORT_RESERVED");
    expect(
      (await readdir(reportDirectory, { withFileTypes: true })).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md"),
      ),
    ).toHaveLength(100);
  });

  it("prunes completed reports that contain reservation-shaped model text", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
    await mkdir(reportDirectory, { recursive: true });
    const spoofedReport = path.join(
      reportDirectory,
      "review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md",
    );
    await writeFile(
      spoofedReport,
      "<!-- PIONEER_REPORT_RESERVED 550e8400-e29b-41d4-a716-446655440000 -->\n",
    );
    for (let index = 0; index < 100; index += 1) {
      await writeFile(
        path.join(
          reportDirectory,
          `review-20260816T000000000Z-${String(index).padStart(32, "0")}.md`,
        ),
        "report",
      );
    }

    await prepareDefaultReviewReportPath({}, process.platform, home);

    await expect(stat(spoofedReport)).rejects.toMatchObject({ code: "ENOENT" });
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
      path.join("/private/root", "550e8400-e29b-41d4-a716-446655440000"),
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
    await expect(stat(path.join(sourceDir, "resume-data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
  }, 15_000);

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

  it("does not retain an attempt without exactly one native session file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "sidecar.txt"), "sidecar");

    await expect(retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      /exactly one native session file/i,
    );

    const secondArchive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(secondArchive.activeAttemptDir, "first.jsonl"), "first");
    await writeFile(path.join(secondArchive.activeAttemptDir, "second.jsonl"), "second");
    await expect(retainReviewResumeArchive(secondArchive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      /exactly one native session file/i,
    );
  });

  it("rolls back to the prior committed attempt when a resumed session is not retainable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "prior-session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const next = await copyReviewResumeSession(archive, archive.activeAttemptDir, 2);
    await symlink("missing", path.join(next.activeAttemptDir, "unsafe"));

    await expect(retainReviewResumeArchive(next, "REVIEW_RPC_INCOMPLETE")).resolves.toBeDefined();
    const loaded = await loadReviewResumeArchive(root, archive.token);
    expect(loaded.archive.activeAttemptDir).toBe(archive.activeAttemptDir);
    expect(
      await readFile(path.join(loaded.archive.activeAttemptDir, "session.jsonl"), "utf8"),
    ).toBe("prior-session");
    await expect(stat(next.activeAttemptDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a valid newer attempt when post-retention pruning fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "prior-session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const next = await copyReviewResumeSession(archive, archive.activeAttemptDir, 2);
    await writeFile(path.join(next.activeAttemptDir, "session.jsonl"), "current-session");

    await expect(
      retainReviewResumeArchive(next, "REVIEW_RPC_INCOMPLETE", async () => {
        throw new Error("pruning failed");
      }),
    ).resolves.toBeDefined();

    const loaded = await loadReviewResumeArchive(root, archive.token);
    expect(loaded.archive.activeAttemptDir).toBe(next.activeAttemptDir);
    expect(await readFile(path.join(next.activeAttemptDir, "session.jsonl"), "utf8")).toBe(
      "current-session",
    );
  });

  it("holds a caller-acquired lease while copying the next attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "prior-session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const leased = await leaseReviewResumeArchive(archive);

    const next = await copyReviewResumeSession(leased, leased.activeAttemptDir, 2);

    expect(next.leaseContents).toBe(leased.leaseContents);
    await retainReviewResumeArchive(next, "REVIEW_RPC_INCOMPLETE");
  });

  it("protects a loaded archive from pruning until its lease is released", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const leased = await leaseReviewResumeArchive(archive);
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, retainedAt: new Date(Date.now() - RESUME_RETENTION_MS - 1).toISOString() })}\n`,
    );

    await pruneReviewResumeArchives(root);
    expect(await stat(archive.archiveDir)).toBeDefined();

    await releaseLeasedReviewResumeArchive(leased);
    await pruneReviewResumeArchives(root);
    await expect(stat(archive.archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls a Pi-rejected copied attempt back to the prior session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "prior-session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const next = await copyReviewResumeSession(archive, archive.activeAttemptDir, 2);

    await rollbackReviewResumeArchiveToPriorAttempt(next, "REVIEW_RESUME_SESSION_INVALID");

    const loaded = await loadReviewResumeArchive(root, archive.token);
    expect(loaded.archive.activeAttemptDir).toBe(archive.activeAttemptDir);
    expect(
      await readFile(path.join(loaded.archive.activeAttemptDir, "session.jsonl"), "utf8"),
    ).toBe("prior-session");
    await expect(stat(next.activeAttemptDir)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("does not treat a reused live PID as the archived lease owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(
      path.join(archive.archiveDir, "lease"),
      `${JSON.stringify({
        pid: process.pid,
        processIdentities: ["0".repeat(64)],
        nonce: "reused",
      })}\n`,
    );

    await expect(reviewResumeArchiveHasLiveLease(archive)).resolves.toBe(false);
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

  it("rejects a retained session that cannot fit beside its next resume attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const sessionPath = path.join(archive.activeAttemptDir, "session.jsonl");
    await writeFile(sessionPath, "session");
    await truncate(sessionPath, MAX_RESUME_ARCHIVE_BYTES / 2 + 1);

    await expect(retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE")).rejects.toThrow(
      /bounded retention limit/i,
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

  it("ignores an archive candidate removed after the pruning snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const vanished = path.join(root, "550e8400-e29b-41d4-a716-446655440000");

    await expect(statReviewResumeArchiveCandidate(vanished)).resolves.toBeUndefined();
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
    await writeFile(path.join(archive.archiveDir, "lease"), archive.leaseContents ?? "");
    await pruneReviewResumeArchives(root);
    expect(await stat(archive.archiveDir)).toBeDefined();
  });

  it("acquires a candidate lease before pruning it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const leased = await leaseReviewResumeArchive(archive);

    await expect(pruneInactiveReviewResumeArchive(archive.archiveDir)).resolves.toBe(false);
    expect(await stat(archive.archiveDir)).toBeDefined();

    await releaseLeasedReviewResumeArchive(leased);
    await expect(pruneInactiveReviewResumeArchive(archive.archiveDir)).resolves.toBe(true);
    await expect(stat(archive.archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("rejects a stored Pi home that overlaps the resume root at load time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      piHomeSource: root,
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");

    await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
      /overlaps an actor-visible grant/i,
    );
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
