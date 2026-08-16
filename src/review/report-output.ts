import crypto from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { currentProcessInstanceIdentities, processInstanceIdentities } from "./work-log.js";

export interface ReviewReportReservation {
  readonly target: string;
  readonly reservationPath: string;
  readonly device: number;
  readonly inode: number;
  readonly marker: string;
  state: "reserved" | "published" | "released";
}

interface ReviewReportReservationOwner {
  readonly id: string;
  readonly pid: number;
  readonly processIdentities: readonly string[];
}

const REVIEW_REPORT_RESERVATION_PATTERN = /^<!-- PIONEER_REPORT_RESERVED (.+) -->\n$/;
const LEGACY_REVIEW_REPORT_RESERVATION_PATTERN =
  /^<!-- PIONEER_REPORT_RESERVED ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->\n$/i;
const REVIEW_REPORT_RESERVATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_INSTANCE_IDENTITY = /^[0-9a-f]{64}$/i;
const MAX_REVIEW_REPORT_RESERVATION_BYTES = 1024;

function parseReviewReportReservationOwner(
  marker: string,
): ReviewReportReservationOwner | undefined {
  const encoded = REVIEW_REPORT_RESERVATION_PATTERN.exec(marker)?.[1];
  if (encoded === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(encoded);
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.id !== "string" ||
      !REVIEW_REPORT_RESERVATION_ID.test(owner.id) ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !Array.isArray(owner.processIdentities) ||
      owner.processIdentities.length === 0 ||
      !owner.processIdentities.every(
        (identity): identity is string =>
          typeof identity === "string" && PROCESS_INSTANCE_IDENTITY.test(identity),
      )
    ) {
      return undefined;
    }
    return {
      id: owner.id,
      pid: owner.pid,
      processIdentities: owner.processIdentities,
    };
  } catch {
    return undefined;
  }
}

function reviewReportReservationOwnerIsLive(
  pid: number,
  ownerIdentities: readonly string[],
): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const currentIdentities = processInstanceIdentities(pid, process.platform);
  return (
    currentIdentities === undefined ||
    currentIdentities.some((identity) => ownerIdentities.includes(identity))
  );
}

export async function isActiveReviewReportReservation(target: string): Promise<boolean> {
  try {
    const targetStats = await lstat(target);
    if (
      !targetStats.isFile() ||
      targetStats.size === 0 ||
      targetStats.size > MAX_REVIEW_REPORT_RESERVATION_BYTES
    ) {
      return false;
    }
    const targetMarker = await readFile(target, "utf8");
    const owner = parseReviewReportReservationOwner(targetMarker);
    const reservationId =
      owner?.id ?? LEGACY_REVIEW_REPORT_RESERVATION_PATTERN.exec(targetMarker)?.[1];
    if (reservationId === undefined) return false;
    const reservationPath = reviewReportReservationPath(target, reservationId);
    const reservationStats = await lstat(reservationPath);
    if (!reservationStats.isFile() || reservationStats.size !== targetStats.size) return false;
    if (
      targetStats.ino !== 0 &&
      reservationStats.ino !== 0 &&
      (targetStats.dev !== reservationStats.dev || targetStats.ino !== reservationStats.ino)
    ) {
      return false;
    }
    const marker = await readFile(reservationPath, "utf8");
    if (marker !== targetMarker) return false;
    if (
      owner !== undefined &&
      reviewReportReservationOwnerIsLive(owner.pid, owner.processIdentities)
    ) {
      return true;
    }
    await unlink(reservationPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function reviewReportReservationPath(target: string, reservationId: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${reservationId}.pioneer-reservation`,
  );
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
  const reservationId = crypto.randomUUID();
  const reservationPath = reviewReportReservationPath(target, reservationId);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const processIdentities = currentProcessInstanceIdentities(process.platform);
  if (processIdentities === undefined) {
    throw new Error(
      `[REVIEW_REPORT_RESERVATION_IDENTITY_UNAVAILABLE] Could not determine review report owner identity: ${process.pid}`,
    );
  }
  const marker = `<!-- PIONEER_REPORT_RESERVED ${JSON.stringify({
    id: reservationId,
    pid: process.pid,
    processIdentities,
  })} -->\n`;
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
  afterOwnershipValidation: () => Promise<void> = async () => {},
): Promise<void> {
  if (reservation.state !== "reserved") {
    throw new Error(`Review report reservation is no longer active: ${reservation.target}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  try {
    handle = await open(reservation.reservationPath, "r+");
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      sameKnownFileIdentity(openedStats, reservation) === false ||
      openedStats.size !== Buffer.byteLength(reservation.marker) ||
      (await handle.readFile("utf8")) !== reservation.marker
    ) {
      throw new Error(`Review report reservation no longer owns target: ${reservation.target}`);
    }
    const [targetStats, sidecarStats] = await Promise.all([
      reservedTargetStats(reservation),
      reservedSidecarStats(reservation),
    ]);
    if (targetStats === undefined || sidecarStats === undefined) {
      throw new Error(`Review report reservation no longer owns target: ${reservation.target}`);
    }
    if ((await reservedTargetStats(reservation)) === undefined) {
      throw new Error(`Review report reservation no longer owns target: ${reservation.target}`);
    }
    await afterOwnershipValidation();
    const contents = Buffer.from(`${report}\n`, "utf8");
    let offset = 0;
    while (offset < contents.length) {
      const { bytesWritten } = await handle.write(
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (bytesWritten <= 0) throw new Error("Review report reservation write made no progress");
      offset += bytesWritten;
    }
    await handle.truncate(contents.length);
    await handle.sync();
    const publishedStats = await lstat(reservation.target).catch(() => undefined);
    const publishedIdentity =
      publishedStats === undefined ? false : sameKnownFileIdentity(publishedStats, reservation);
    if (
      publishedStats === undefined ||
      !publishedStats.isFile() ||
      publishedIdentity === false ||
      (publishedIdentity === undefined &&
        !(await readFile(reservation.target).then((value) => value.equals(contents))))
    ) {
      throw new Error(`Review report reservation no longer owns target: ${reservation.target}`);
    }
    reservation.state = "published";
    await handle.close();
    handle = undefined;
    await unlink(reservation.reservationPath).catch(() => {});
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure ??= error;
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
