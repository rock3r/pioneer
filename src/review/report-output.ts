import crypto from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export interface ReviewReportReservation {
  readonly target: string;
  readonly reservationPath: string;
  readonly device: number;
  readonly inode: number;
  readonly marker: string;
  state: "reserved" | "published" | "released";
}

const REVIEW_REPORT_RESERVATION_PATTERN =
  /^<!-- PIONEER_REPORT_RESERVED [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->\n$/i;
const MAX_REVIEW_REPORT_RESERVATION_BYTES = 96;

export async function isActiveReviewReportReservation(target: string): Promise<boolean> {
  try {
    const reservationPath = reviewReportReservationPath(target);
    const [targetStats, reservationStats] = await Promise.all([
      lstat(target),
      lstat(reservationPath),
    ]);
    if (
      !targetStats.isFile() ||
      !reservationStats.isFile() ||
      targetStats.size === 0 ||
      targetStats.size > MAX_REVIEW_REPORT_RESERVATION_BYTES ||
      reservationStats.size !== targetStats.size
    ) {
      return false;
    }
    if (
      targetStats.ino !== 0 &&
      reservationStats.ino !== 0 &&
      (targetStats.dev !== reservationStats.dev || targetStats.ino !== reservationStats.ino)
    ) {
      return false;
    }
    const marker = await readFile(reservationPath, "utf8");
    return (
      REVIEW_REPORT_RESERVATION_PATTERN.test(marker) && (await readFile(target, "utf8")) === marker
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function reviewReportReservationPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.pioneer-reservation`);
}

function sameKnownFileIdentity(
  stats: Stats,
  reservation: ReviewReportReservation,
): boolean | undefined {
  if (stats.ino === 0 || reservation.inode === 0) return undefined;
  return stats.dev === reservation.device && stats.ino === reservation.inode;
}

async function reservedTargetStats(
  reservation: ReviewReportReservation,
): Promise<Stats | undefined> {
  try {
    const stats = await lstat(reservation.target);
    if (!stats.isFile() || sameKnownFileIdentity(stats, reservation) === false) return undefined;
    if (stats.size !== Buffer.byteLength(reservation.marker)) return undefined;
    return (await readFile(reservation.target, "utf8")) === reservation.marker ? stats : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function reservedSidecarStats(
  reservation: ReviewReportReservation,
): Promise<Stats | undefined> {
  try {
    const stats = await lstat(reservation.reservationPath);
    if (!stats.isFile() || sameKnownFileIdentity(stats, reservation) === false) return undefined;
    if (stats.size !== Buffer.byteLength(reservation.marker)) return undefined;
    return (await readFile(reservation.reservationPath, "utf8")) === reservation.marker
      ? stats
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type WriteReviewReportReservationMarker = (
  handle: Awaited<ReturnType<typeof open>>,
  marker: string,
) => Promise<void>;

export async function reserveReviewReport(
  target: string,
  writeMarker: WriteReviewReportReservationMarker = async (handle, marker) => {
    await handle.writeFile(marker, "utf8");
  },
): Promise<ReviewReportReservation> {
  const reservationPath = reviewReportReservationPath(target);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const marker = `<!-- PIONEER_REPORT_RESERVED ${crypto.randomUUID()} -->\n`;
  let reservation: ReviewReportReservation = {
    target,
    reservationPath,
    device: 0,
    inode: 0,
    marker,
    state: "reserved",
  };
  let reservationCreated = false;
  let targetCreated = false;
  try {
    handle = await open(reservationPath, "wx", 0o600);
    reservationCreated = true;
    await writeMarker(handle, marker);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(reservationPath, target);
      targetCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Review report target already exists: ${target}`);
      }
      throw error;
    }
    const stats = await lstat(target);
    reservation = {
      target,
      reservationPath,
      device: stats.dev,
      inode: stats.ino,
      marker,
      state: "reserved",
    };
    if (
      (await reservedTargetStats(reservation)) === undefined ||
      (await reservedSidecarStats(reservation)) === undefined
    ) {
      throw new Error(`Review report reservation no longer owns target: ${target}`);
    }
    return reservation;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (targetCreated) await releaseReviewReportReservation(reservation).catch(() => {});
    else if (reservationCreated) await unlink(reservationPath).catch(() => {});
    throw error;
  }
}

export async function publishReservedReviewReport(
  reservation: ReviewReportReservation,
  report: string,
): Promise<void> {
  if (reservation.state !== "reserved") {
    throw new Error(`Review report reservation is no longer active: ${reservation.target}`);
  }
  const temporary = path.join(
    path.dirname(reservation.target),
    `.${path.basename(reservation.target)}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let failure: unknown;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${report}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const [targetStats, sidecarStats] = await Promise.all([
      reservedTargetStats(reservation),
      reservedSidecarStats(reservation),
    ]);
    if (targetStats === undefined || sidecarStats === undefined) {
      throw new Error(`Review report reservation no longer owns target: ${reservation.target}`);
    }
    await rename(temporary, reservation.target);
    reservation.state = "published";
    published = true;
    await unlink(reservation.reservationPath);
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await rm(temporary, { force: true });
  } catch (error) {
    if (!published) failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

export async function releaseReviewReportReservation(
  reservation: ReviewReportReservation,
): Promise<void> {
  if (reservation.state !== "reserved") return;
  const [targetStats, sidecarStats] = await Promise.all([
    reservedTargetStats(reservation),
    reservedSidecarStats(reservation),
  ]);
  if (targetStats !== undefined) await unlink(reservation.target);
  if (sidecarStats !== undefined) await unlink(reservation.reservationPath);
  reservation.state = "released";
}

export async function writeReviewReport(target: string, report: string): Promise<void> {
  let reservation: ReviewReportReservation | undefined;
  try {
    reservation = await reserveReviewReport(target);
    await publishReservedReviewReport(reservation, report);
  } catch (error) {
    if (reservation !== undefined)
      await releaseReviewReportReservation(reservation).catch(() => {});
    throw error;
  }
}
