import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const unlinkFile = vi.hoisted(() =>
  vi.fn(async (...args: Parameters<typeof import("node:fs/promises").unlink>) => {
    const { unlink } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return unlink(...args);
  }),
);

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  unlink: unlinkFile,
}));

import {
  isActiveReviewReportReservation,
  publishReservedReviewReport,
  releaseReviewReportReservation,
  reserveReviewReport,
  writeReviewReport,
} from "./report-output.js";
import { persistReviewReport } from "./runner.js";

describe("review report output", () => {
  it("reserves the private report target before publishing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");

    const reservation = await reserveReviewReport(target);

    expect(await readFile(target, "utf8")).toContain("PIONEER_REPORT_RESERVED");
    await expect(isActiveReviewReportReservation(target)).resolves.toBe(true);
    await publishReservedReviewReport({ ...reservation, device: 0, inode: 0 }, "No findings.");
    expect(await readFile(target, "utf8")).toBe("No findings.\n");
    await expect(isActiveReviewReportReservation(target)).resolves.toBe(false);
    await expect(stat(reservation.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let published model text spoof an active reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);

    await publishReservedReviewReport(reservation, reservation.marker.trimEnd());

    expect(await readFile(target, "utf8")).toBe(reservation.marker);
    await expect(isActiveReviewReportReservation(target)).resolves.toBe(false);
  });

  it("reclaims a report reservation whose controller is no longer live", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    await writeFile(target, reservation.marker.replace(`"pid":${process.pid}`, '"pid":2147483647'));

    await expect(isActiveReviewReportReservation(target)).resolves.toBe(false);

    await expect(stat(reservation.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target, "utf8")).toContain('"pid":2147483647');
  });

  it("does not let an orphaned sidecar block reusing an absent report target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const orphaned = await reserveReviewReport(target);
    await import("node:fs/promises").then(({ rm }) => rm(target));

    const replacement = await reserveReviewReport(target);

    expect(replacement.reservationPath).not.toBe(orphaned.reservationPath);
    await releaseReviewReportReservation(replacement);
    await import("node:fs/promises").then(({ rm }) => rm(orphaned.reservationPath));
  });

  it("does not publish over or remove a replaced report reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    await import("node:fs/promises").then(({ rm }) => rm(target));
    await writeFile(target, "replacement\n");

    await expect(publishReservedReviewReport(reservation, "No findings.")).rejects.toThrow(
      /reservation/i,
    );
    await releaseReviewReportReservation(reservation);

    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("does not remove a report target replaced after release ownership validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);

    await releaseReviewReportReservation(reservation, async () => {
      await import("node:fs/promises").then(({ rm }) => rm(target));
      await writeFile(target, "replacement\n");
    });

    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("does not overwrite a report target replaced after ownership validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);

    await expect(
      publishReservedReviewReport(reservation, "No findings.", async () => {
        await import("node:fs/promises").then(({ rm }) => rm(target));
        await writeFile(target, "replacement\n");
      }),
    ).rejects.toThrow(/reservation/i);

    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("keeps a report reservation active while publishing through its owned inode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    let observedPublishingState = false;

    await publishReservedReviewReport(
      reservation,
      "No findings.",
      async () => {},
      async () => {
        observedPublishingState = true;
        expect(await readFile(target, "utf8")).not.toBe(reservation.marker);
        await expect(isActiveReviewReportReservation(target)).resolves.toBe(true);
      },
    );

    expect(observedPublishingState).toBe(true);
    expect(await readFile(target, "utf8")).toBe("No findings.\n");
  });

  it("restores and removes its reservation after publication fails post-write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reserved = await reserveReviewReport(target);
    const reservation = { ...reserved, device: 0, inode: 0 };

    await expect(
      publishReservedReviewReport(
        reservation,
        "No findings.",
        async () => {},
        async () => {
          throw new Error("publication failed");
        },
      ),
    ).rejects.toThrow("publication failed");

    expect(await readFile(target, "utf8")).toBe(reservation.marker);
    await releaseReviewReportReservation(reservation);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(reservation.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a durable report when closing its published handle fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    let closeAttempted = false;

    await expect(
      publishReservedReviewReport(
        reservation,
        "No findings.",
        async () => {},
        async () => {},
        async (handle) => {
          closeAttempted = true;
          await handle.close();
          throw new Error("close failed");
        },
      ),
    ).resolves.toBeUndefined();

    expect(closeAttempted).toBe(true);
    expect(await readFile(target, "utf8")).toBe("No findings.\n");
    expect(reservation.state).toBe("published");
  });

  it("does not remove publication sidecars replaced after final report validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);

    await publishReservedReviewReport(
      reservation,
      "No findings.",
      async () => {},
      async () => {},
      async (handle) => {
        await handle.close();
        await import("node:fs/promises").then(({ rm }) =>
          Promise.all([rm(reservation.reservationPath), rm(reservation.publicationPath)]),
        );
        await Promise.all([
          writeFile(reservation.reservationPath, "replacement reservation\n"),
          writeFile(reservation.publicationPath, "replacement publication\n"),
        ]);
      },
    );

    expect(await readFile(reservation.reservationPath, "utf8")).toBe("replacement reservation\n");
    expect(await readFile(reservation.publicationPath, "utf8")).toBe("replacement publication\n");
  });

  it("removes an unpublished report reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);

    await releaseReviewReportReservation(reservation);

    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(reservation.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a reservation that was modified in place", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    await writeFile(target, "replacement\n");

    await releaseReviewReportReservation(reservation);

    expect(await readFile(target, "utf8")).toBe("replacement\n");
  });

  it("does not orphan the create-only target when marker preparation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");

    await expect(
      reserveReviewReport(target, async (handle, marker) => {
        await handle.writeFile(marker.slice(0, 8), "utf8");
        throw new Error("marker write failed");
      }),
    ).rejects.toThrow("marker write failed");

    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.endsWith(".pioneer-reservation"))).toEqual(
      [],
    );
  });

  it("creates a private report file through its owned reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const reports = path.join(root, "reports");
    const target = path.join(reports, "report.md");
    await mkdir(reports);

    await writeReviewReport(target, "No findings.");

    expect(await readFile(target, "utf8")).toBe("No findings.\n");
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it("never overwrites an existing report target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    await writeFile(target, "existing\n");

    await expect(writeReviewReport(target, "replacement")).rejects.toThrow(/already exists/i);

    expect(await readFile(target, "utf8")).toBe("existing\n");
  });

  it("does not turn a published report into a failure when sidecar cleanup fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    const reservation = await reserveReviewReport(target);
    unlinkFile.mockRejectedValueOnce(new Error("sidecar cleanup failed"));

    await expect(publishReservedReviewReport(reservation, "No findings.")).resolves.toBeUndefined();

    expect(await readFile(target, "utf8")).toBe("No findings.\n");
    expect(reservation.state).toBe("published");
  });

  it("preserves a valid report when optional persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pioneer-review-report-"));
    const target = path.join(root, "report.md");
    await writeFile(target, "existing\n");

    await expect(persistReviewReport("Valid report", target)).resolves.toBe(
      `[REVIEW_REPORT_WRITE_FAILED] Pioneer received a review report but could not persist it at ${target}: Review report target already exists: ${target}`,
    );
    expect(await readFile(target, "utf8")).toBe("existing\n");
  });
});
