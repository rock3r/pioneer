import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
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
import { publishReservedReviewReport, reserveReviewReport } from "./report-output.js";
import {
  copyReviewResumeSession,
  createReviewResumeArchive,
  defaultReviewReportDirectory,
  defaultReviewResumeDirectory,
  findReviewResumeSessionFile,
  immutableReviewScope,
  inspectReviewResumeSessionTree,
  isResumeToken,
  isTrustedApplicationDataOwner,
  isTrustedStickyApplicationDataParent,
  leaseReviewResumeArchive,
  loadReviewResumeArchive,
  MAX_RESUME_ARCHIVE_BYTES,
  MAX_RESUME_MANIFEST_BYTES,
  prepareDefaultReviewReportPath,
  prepareDefaultReviewResumeDirectory,
  prepareValidatedDefaultReviewReportPath,
  pruneInactiveReviewResumeArchive,
  pruneReviewResumeArchives,
  publishReviewResumeArchiveLease,
  RESUME_CLOCK_SKEW_MS,
  RESUME_RETENTION_MS,
  releaseLeasedReviewResumeArchive,
  restoreDisplacedReviewResumeArchiveLease,
  resumeArchivePath,
  retainReviewResumeArchive,
  reviewResumeArchiveHasLiveLease,
  rollbackReviewResumeArchiveToPriorAttempt,
  statReviewResumeArchiveCandidate,
  validatePublishedReviewResumeArchiveLease,
} from "./resume-archive.js";

describe("recoverable review archive", () => {
  it("trusts sticky ancestry only when its owner can protect the caller-owned entry", () => {
    expect(isTrustedApplicationDataOwner(0, 501)).toBe(true);
    expect(isTrustedApplicationDataOwner(501, 501)).toBe(true);
    expect(isTrustedApplicationDataOwner(502, 501)).toBe(false);
    expect(isTrustedStickyApplicationDataParent(0, 501, 501)).toBe(true);
    expect(isTrustedStickyApplicationDataParent(501, 501, 501)).toBe(true);
    expect(isTrustedStickyApplicationDataParent(502, 501, 501)).toBe(false);
    expect(isTrustedStickyApplicationDataParent(0, 502, 501)).toBe(false);
  });

  it("publishes only complete resume leases at the canonical lease path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-lease-"));
    const leasePath = path.join(root, "lease");
    const contents = `${JSON.stringify({ pid: process.pid, nonce: "lease" })}\n`;

    await publishReviewResumeArchiveLease(leasePath, contents, async (pendingPath) => {
      expect(await readFile(pendingPath, "utf8")).toBe(contents);
      await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    expect(await readFile(leasePath, "utf8")).toBe(contents);
  });

  it("does not overwrite a contender while restoring a displaced lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-lease-"));
    const leasePath = path.join(root, "lease");
    const displacedPath = path.join(root, "lease.stale-race");
    await writeFile(displacedPath, "displaced-owner\n");
    await writeFile(leasePath, "new-contender\n");

    await expect(restoreDisplacedReviewResumeArchiveLease(displacedPath, leasePath)).resolves.toBe(
      false,
    );
    expect(await readFile(leasePath, "utf8")).toBe("new-contender\n");
    expect(await readFile(displacedPath, "utf8")).toBe("displaced-owner\n");
  });

  it("backs a publisher off when a displaced live owner could not be restored", async () => {
    const displacedRoot = await mkdtemp(path.join(tmpdir(), "pioneer-resume-lease-"));
    const contenderRoot = await mkdtemp(path.join(tmpdir(), "pioneer-resume-lease-"));
    const displaced = await createReviewResumeArchive(displacedRoot, {
      sourceDir: "/repo",
      prompt: "displaced",
      network: "none",
      piVersion: "0.84.2",
    });
    const contender = await createReviewResumeArchive(contenderRoot, {
      sourceDir: "/repo",
      prompt: "contender",
      network: "none",
      piVersion: "0.84.2",
    });
    const leasePath = path.join(displaced.archiveDir, "lease");
    const displacedPath = `${leasePath}.stale-race`;
    const displacedContents = displaced.leaseContents ?? "";
    const contenderContents = contender.leaseContents ?? "";
    await rename(leasePath, displacedPath);
    await writeFile(leasePath, contenderContents);

    await expect(
      validatePublishedReviewResumeArchiveLease(
        displaced.archiveDir,
        contenderContents,
        async () => {
          await writeFile(leasePath, "third-contender\n", { flag: "wx" });
        },
      ),
    ).rejects.toThrow("[REVIEW_RESUME_IN_USE]");
    expect(await readFile(leasePath, "utf8")).toBe("third-contender\n");
    expect(await readFile(displacedPath, "utf8")).toBe(displacedContents);
  });

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
  }, 15_000);

  it("revalidates a report reservation immediately before retention unlinks it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
    await mkdir(reportDirectory, { recursive: true });
    const lateReport = path.join(
      reportDirectory,
      "review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md",
    );
    await writeFile(lateReport, "stale report");
    for (let index = 0; index < 100; index += 1) {
      await writeFile(
        path.join(
          reportDirectory,
          `review-20260816T000000000Z-${String(index).padStart(32, "0")}.md`,
        ),
        "newer report",
      );
    }
    let continuePublication!: () => void;
    const publicationMayContinue = new Promise<void>((resolve) => {
      continuePublication = resolve;
    });
    let publication: Promise<void> | undefined;

    await prepareValidatedDefaultReviewReportPath(
      async () => {},
      {},
      process.platform,
      home,
      async (candidate) => {
        if (candidate !== lateReport) return;
        await rm(candidate);
        const reservation = await reserveReviewReport(candidate);
        let publicationStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          publicationStarted = resolve;
        });
        publication = publishReservedReviewReport(reservation, "Late report", async () => {
          publicationStarted();
          await publicationMayContinue;
        });
        await started;
      },
    );
    continuePublication();
    await publication;

    expect(await readFile(lateReport, "utf8")).toBe("Late report\n");
  });

  it("does not reclaim a live reservation before its target link is created", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
    await mkdir(reportDirectory, { recursive: true });
    const report = path.join(
      reportDirectory,
      "review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md",
    );
    let markerReady!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      markerReady = resolve;
    });
    let continueSetup!: () => void;
    const setupMayContinue = new Promise<void>((resolve) => {
      continueSetup = resolve;
    });
    const reservationPromise = reserveReviewReport(report, async (handle, marker) => {
      await handle.writeFile(marker, "utf8");
      markerReady();
      await setupMayContinue;
    });
    await markerWritten;

    await prepareDefaultReviewReportPath({}, process.platform, home);
    continueSetup();

    const reservation = await reservationPromise;
    expect(await readFile(report, "utf8")).toBe(reservation.marker);
  });

  it("reclaims an orphaned published report reservation sibling", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
    await mkdir(reportDirectory, { recursive: true });
    const report = path.join(
      reportDirectory,
      "review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md",
    );
    const reservation = await reserveReviewReport(report);
    await publishReservedReviewReport(reservation, "No findings.");
    await link(report, reservation.reservationPath);

    await prepareDefaultReviewReportPath({}, process.platform, home);

    expect(await readFile(report, "utf8")).toBe("No findings.\n");
    await expect(stat(reservation.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a crashed report-release quarantine after its setup grace", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pioneer-report-home-"));
    const reportDirectory = defaultReviewReportDirectory({}, process.platform, home);
    await mkdir(reportDirectory, { recursive: true });
    const report = path.join(
      reportDirectory,
      "review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md",
    );
    const quarantine = path.join(
      reportDirectory,
      ".review-20260815T000000000Z-550e8400-e29b-41d4-a716-446655440000.md.550e8400-e29b-41d4-a716-446655440001.pioneer-releasing",
    );
    await writeFile(report, "No findings.\n");
    await rename(report, quarantine);
    const staleTime = new Date(Date.now() - 60_001);
    await utimes(quarantine, staleTime, staleTime);

    await prepareDefaultReviewReportPath({}, process.platform, home);

    await expect(stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
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

  it.runIf(process.platform !== "win32")(
    "rejects a replaceable application-data parent before creating resume storage",
    async () => {
      const sharedData = await mkdtemp(path.join(tmpdir(), "pioneer-shared-data-"));
      await chmod(sharedData, 0o777);

      await expect(
        prepareDefaultReviewResumeDirectory(
          {},
          { XDG_DATA_HOME: sharedData },
          "linux",
          path.dirname(sharedData),
        ),
      ).rejects.toThrow(/application-data parent.*writable/i);
      await expect(stat(path.join(sharedData, "pioneer"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows a trusted sticky application-data parent with a caller-owned private child",
    async () => {
      const stickyData = await mkdtemp(path.join(tmpdir(), "pioneer-sticky-data-"));
      await chmod(stickyData, 0o1777);

      const resumeRoot = await prepareDefaultReviewResumeDirectory(
        {},
        { XDG_DATA_HOME: stickyData },
        "linux",
        path.dirname(stickyData),
      );

      expect(resumeRoot).toBe(path.join(stickyData, "pioneer", "review-resumes"));
      expect((await stat(path.join(stickyData, "pioneer"))).mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a replaceable application-data parent before preparing default reports",
    async () => {
      const sharedData = await mkdtemp(path.join(tmpdir(), "pioneer-shared-reports-"));
      await chmod(sharedData, 0o777);

      await expect(
        prepareValidatedDefaultReviewReportPath(
          async () => {},
          { XDG_DATA_HOME: sharedData },
          "linux",
          path.dirname(sharedData),
        ),
      ).rejects.toThrow(/application-data parent.*writable/i);
      await expect(stat(path.join(sharedData, "pioneer"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a private data root owned by a replaceable directory entry",
    async () => {
      const sharedParent = await mkdtemp(path.join(tmpdir(), "pioneer-shared-parent-"));
      const privateData = path.join(sharedParent, "private-data");
      await chmod(sharedParent, 0o777);
      await mkdir(privateData, { mode: 0o700 });

      await expect(
        prepareValidatedDefaultReviewReportPath(
          async () => {},
          { XDG_DATA_HOME: privateData },
          "linux",
          path.dirname(sharedParent),
        ),
      ).rejects.toThrow(/application-data parent.*writable/i);
      await expect(stat(path.join(privateData, "pioneer"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects an overlapping default resume root before mutating its application directory", async () => {
    const sourceDir = await mkdtemp(path.join(tmpdir(), "pioneer-resume-parent-overlap-"));
    const environment =
      process.platform === "win32" ? { LOCALAPPDATA: sourceDir } : { XDG_DATA_HOME: sourceDir };
    const applicationDirectory =
      process.platform === "darwin"
        ? path.join(sourceDir, "Library", "Application Support", "Pioneer")
        : path.join(sourceDir, process.platform === "win32" ? "Pioneer" : "pioneer");

    await expect(
      prepareDefaultReviewResumeDirectory(
        { actorVisiblePaths: [sourceDir] },
        environment,
        process.platform,
        sourceDir,
      ),
    ).rejects.toThrow(/resume root overlaps an actor-visible grant/i);
    await expect(stat(applicationDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("acquires the archive lease before validating loaded contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    let observedPrevalidationLease = false;

    const loaded = await loadReviewResumeArchive(root, archive.token, async (leasedArchive) => {
      observedPrevalidationLease = true;
      await expect(reviewResumeArchiveHasLiveLease(leasedArchive)).resolves.toBe(true);
    });

    expect(observedPrevalidationLease).toBe(true);
    expect(loaded.archive.preacquiredLease).toBe(true);
    await releaseLeasedReviewResumeArchive(loaded.archive);
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
    await releaseLeasedReviewResumeArchive(archive);
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
    await releaseLeasedReviewResumeArchive(archive);
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
    await releaseLeasedReviewResumeArchive(second);
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
    await releaseLeasedReviewResumeArchive(archive);
    await pruneReviewResumeArchives(root);
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(manifestTemp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves stale temporary entries while a live lease owns the archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const staleTime = new Date(Date.now() - RESUME_RETENTION_MS - 1);
    const staging = path.join(archive.attemptsDir, ".attempt-live");
    const manifestTemp = path.join(archive.archiveDir, "manifest.json.tmp-live");
    await mkdir(staging);
    await writeFile(manifestTemp, "live");
    await utimes(staging, staleTime, staleTime);
    await utimes(manifestTemp, staleTime, staleTime);

    await pruneReviewResumeArchives(root);

    await expect(stat(staging)).resolves.toBeDefined();
    await expect(stat(manifestTemp)).resolves.toBeDefined();
    await releaseLeasedReviewResumeArchive(archive);
  });

  it("ignores an archive candidate removed after the pruning snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const vanished = path.join(root, "550e8400-e29b-41d4-a716-446655440000");

    await expect(statReviewResumeArchiveCandidate(vanished)).resolves.toBeUndefined();
  });

  it("prunes stale lease takeover and publication temporary entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    const staleLease = path.join(archive.archiveDir, "lease.stale-crashed");
    const pendingLease = path.join(archive.archiveDir, "lease.pending-crashed");
    const staleTime = new Date(Date.now() - RESUME_RETENTION_MS - 1);
    await writeFile(staleLease, "stale");
    await writeFile(pendingLease, "pending");
    await utimes(staleLease, staleTime, staleTime);
    await utimes(pendingLease, staleTime, staleTime);
    await releaseLeasedReviewResumeArchive(archive);
    await pruneReviewResumeArchives(root);
    await expect(stat(staleLease)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(pendingLease)).rejects.toMatchObject({ code: "ENOENT" });
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
    await releaseLeasedReviewResumeArchive(archive);
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

  it("reclaims crashed staging attempts before copying the next attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "committed");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const crashedStaging = path.join(archive.attemptsDir, ".attempt-crashed");
    await mkdir(crashedStaging);
    await writeFile(path.join(crashedStaging, "partial.jsonl"), "partial");

    const next = await copyReviewResumeSession(archive, archive.activeAttemptDir, 2);

    await expect(stat(crashedStaging)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(next.activeAttemptDir, "session.jsonl"), "utf8")).toBe(
      "committed",
    );
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

  it("recomputes count retention after a selected archive is freshly retained", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const now = Date.now();
    const archives: Awaited<ReturnType<typeof createReviewResumeArchive>>[] = [];
    for (let index = 0; index < 11; index += 1) {
      const archive = await createReviewResumeArchive(root, {
        sourceDir: "/repo",
        prompt: `x-${index}`,
        network: "none",
        piVersion: "0.84.2",
      });
      const manifestPath = path.join(archive.archiveDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          ...manifest,
          state: "retained",
          retainedAt: new Date(now - (11 - index) * 1_000).toISOString(),
        })}\n`,
      );
      await releaseLeasedReviewResumeArchive(archive);
      archives.push(archive);
    }
    const refreshed = archives[0];
    if (refreshed === undefined) throw new Error("Expected a retained archive fixture");

    await pruneReviewResumeArchives(root, now, async () => {
      const manifestPath = path.join(refreshed.archiveDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, retainedAt: new Date(now + 1_000).toISOString() })}\n`,
      );
    });

    await expect(stat(refreshed.archiveDir)).resolves.toBeDefined();
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
    await releaseLeasedReviewResumeArchive(archive);
    await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume archive has expired",
    );
  });

  it("rejects every malformed present immutable-scope field", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-resume-"));
    const archive = await createReviewResumeArchive(root, {
      sourceDir: "/repo",
      prompt: "x",
      model: "provider/model",
      thinking: "high",
      piHomeSource: "/pi",
      piHomeIncludes: ["skills/example"],
      allowReadPaths: ["/reference"],
      allowWritePaths: ["/output"],
      network: "none",
      piVersion: "0.84.2",
    });
    await writeFile(path.join(archive.activeAttemptDir, "session.jsonl"), "session");
    await retainReviewResumeArchive(archive, "REVIEW_RPC_INCOMPLETE");
    const manifestPath = path.join(archive.archiveDir, "manifest.json");
    const validManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const validScope = validManifest.scope as Record<string, unknown>;

    for (const [field, invalidValue] of [
      ["model", 42],
      ["thinking", []],
      ["piHomeSource", false],
      ["piHomeIncludes", ["skills/example", 42]],
      ["allowReadPaths", ["/reference", false]],
      ["allowWritePaths", "/output"],
    ] as const) {
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          ...validManifest,
          scope: { ...validScope, [field]: invalidValue },
        })}\n`,
      );
      await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
        "[REVIEW_RESUME_UNAVAILABLE] Review resume scope is invalid",
      );
    }
  });

  it("rejects and prunes an implausibly future archive timestamp", async () => {
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
      `${JSON.stringify({
        ...manifest,
        retainedAt: new Date(Date.now() + RESUME_CLOCK_SKEW_MS + 1_000).toISOString(),
      })}\n`,
    );

    await expect(loadReviewResumeArchive(root, archive.token)).rejects.toThrow(
      "[REVIEW_RESUME_UNAVAILABLE] Review resume lifecycle timestamp is invalid",
    );
    await pruneReviewResumeArchives(root);
    await expect(stat(archive.archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
