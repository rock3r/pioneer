import crypto from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export interface ReviewReportReservation {
  readonly target: string;
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
    const stats = await lstat(target);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_REVIEW_REPORT_RESERVATION_BYTES) {
      return false;
    }
    return REVIEW_REPORT_RESERVATION_PATTERN.test(await readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.reserve`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const marker = `<!-- PIONEER_REPORT_RESERVED ${crypto.randomUUID()} -->\n`;
  let reservation: ReviewReportReservation = {
    target,
    device: 0,
    inode: 0,
    marker,
    state: "reserved",
  };
  let targetCreated = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeMarker(handle, marker);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
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
      device: stats.dev,
      inode: stats.ino,
      marker,
      state: "reserved",
    };
    if ((await reservedTargetStats(reservation)) === undefined) {
      throw new Error(`Review report reservation no longer owns target: ${target}`);
    }
    await unlink(temporary).catch(() => {});
    return reservation;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (targetCreated) await releaseReviewReportReservation(reservation).catch(() => {});
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
    const targetStats = await reservedTargetStats(reservation);
    if (targetStats === undefined) {
      throw new Error(`Review report reservation no longer owns target: ${reservation.target}`);
    }
    await rename(temporary, reservation.target);
    reservation.state = "published";
    published = true;
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
  const targetStats = await reservedTargetStats(reservation);
  if (targetStats !== undefined) await unlink(reservation.target);
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
