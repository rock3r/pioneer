import crypto from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export interface ReviewReportReservation {
  readonly target: string;
  readonly device: number;
  readonly inode: number;
  state: "reserved" | "published" | "released";
}

function sameFile(stats: Stats, reservation: ReviewReportReservation): boolean {
  return stats.isFile() && stats.dev === reservation.device && stats.ino === reservation.inode;
}

async function reservedTargetStats(
  reservation: ReviewReportReservation,
): Promise<Stats | undefined> {
  try {
    const stats = await lstat(reservation.target);
    return sameFile(stats, reservation) ? stats : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function reserveReviewReport(target: string): Promise<ReviewReportReservation> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reservation: ReviewReportReservation | undefined;
  try {
    try {
      handle = await open(target, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Review report target already exists: ${target}`);
      }
      throw error;
    }
    const stats = await handle.stat();
    reservation = {
      target,
      device: stats.dev,
      inode: stats.ino,
      state: "reserved",
    };
    await handle.sync();
    await handle.close();
    return reservation;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (reservation !== undefined)
      await releaseReviewReportReservation(reservation).catch(() => {});
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
    if (targetStats === undefined || targetStats.size !== 0) {
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
  if (targetStats?.size === 0) await unlink(reservation.target);
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
