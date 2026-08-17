import crypto from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { currentProcessInstanceIdentities, processInstanceIdentities } from "./work-log.js";

export interface ReviewReportReservation {
  readonly target: string;
  readonly reservationPath: string;
  readonly publicationPath: string;
  readonly device: number;
  readonly inode: number;
  readonly marker: string;
  state: "reserved" | "publishing" | "published" | "released";
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
const INCOMPLETE_REVIEW_REPORT_SIDECAR_GRACE_MS = 60_000;
const REVIEW_REPORT_RESERVATION_PREFIX = "<!-- PIONEER_REPORT_RESERVED ";

function reviewReportPublicationPath(target: string, reservationId: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${reservationId}.pioneer-publishing`,
  );
}

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

export async function shouldProtectReviewReportSidecar(
  sidecarPath: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const stats = await lstat(sidecarPath);
    if (!stats.isFile() || stats.size > MAX_REVIEW_REPORT_RESERVATION_BYTES) return false;
    const ageMs = now - stats.mtimeMs;
    if (stats.size === 0) {
      return (
        ageMs >= -INCOMPLETE_REVIEW_REPORT_SIDECAR_GRACE_MS &&
        ageMs <= INCOMPLETE_REVIEW_REPORT_SIDECAR_GRACE_MS
      );
    }
    const marker = await readFile(sidecarPath, "utf8");
    const owner = parseReviewReportReservationOwner(marker);
    if (owner !== undefined) {
      return reviewReportReservationOwnerIsLive(owner.pid, owner.processIdentities);
    }
    return (
      marker.startsWith(REVIEW_REPORT_RESERVATION_PREFIX) &&
      ageMs >= -INCOMPLETE_REVIEW_REPORT_SIDECAR_GRACE_MS &&
      ageMs <= INCOMPLETE_REVIEW_REPORT_SIDECAR_GRACE_MS
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isActiveReviewReportReservation(target: string): Promise<boolean> {
  const publicationPrefix = `.${path.basename(target)}.`;
  const publicationSuffix = ".pioneer-publishing";
  const publicationEntries = await readdir(path.dirname(target)).catch(
    (error: unknown): string[] => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of publicationEntries) {
    if (!entry.startsWith(publicationPrefix) || !entry.endsWith(publicationSuffix)) continue;
    const publicationPath = path.join(path.dirname(target), entry);
    try {
      const stats = await lstat(publicationPath);
      if (!stats.isFile() || stats.size > MAX_REVIEW_REPORT_RESERVATION_BYTES) {
        continue;
      }
      if (await shouldProtectReviewReportSidecar(publicationPath)) return true;
      await unlink(publicationPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
  return await reservedFileStats(reservation.target, reservation);
}

async function reservedFileStats(
  file: string,
  reservation: ReviewReportReservation,
): Promise<Stats | undefined> {
  try {
    const stats = await lstat(file);
    if (!stats.isFile() || sameKnownFileIdentity(stats, reservation) === false) return undefined;
    if (stats.size !== Buffer.byteLength(reservation.marker)) return undefined;
    return (await readFile(file, "utf8")) === reservation.marker ? stats : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function reservedSidecarStats(
  reservation: ReviewReportReservation,
): Promise<Stats | undefined> {
  return await reservedFileStats(reservation.reservationPath, reservation);
}

async function ownedPublishingFileStats(
  file: string,
  reservation: ReviewReportReservation,
): Promise<Stats | undefined> {
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) return undefined;
    const identity = sameKnownFileIdentity(stats, reservation);
    if (identity === true) return stats;
    if (identity === false || stats.size !== Buffer.byteLength(reservation.marker)) {
      return undefined;
    }
    return (await readFile(file, "utf8")) === reservation.marker ? stats : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ownsPublishedReviewReportFile(
  file: string,
  reservation: ReviewReportReservation,
  contents: Buffer,
): Promise<boolean> {
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) return false;
    const identity = sameKnownFileIdentity(stats, reservation);
    if (identity !== undefined) return identity;
    return (await readFile(file)).equals(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readPublicationMarker(
  reservation: ReviewReportReservation,
): Promise<string | undefined> {
  try {
    return await readFile(reservation.publicationPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreQuarantinedReviewReportPath(
  quarantinePath: string,
  originalPath: string,
): Promise<void> {
  const preservedPath = await preserveQuarantinedReviewReportPath(quarantinePath, originalPath);
  try {
    await link(preservedPath, originalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Review report replacement was preserved at ${preservedPath}`, {
        cause: error,
      });
    }
    throw new Error(`Review report replacement was preserved at ${preservedPath}`, {
      cause: error,
    });
  }
}

async function preserveQuarantinedReviewReportPath(
  quarantinePath: string,
  originalPath: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const preservedPath = path.join(
      path.dirname(originalPath),
      `${path.basename(originalPath)}.pioneer-preserved-${crypto.randomUUID()}`,
    );
    try {
      await rename(quarantinePath, preservedPath);
      return preservedPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Review report replacement could not be moved out of cleanup quarantine");
}

async function removeOwnedReviewReportPath(
  originalPath: string,
  ownsPath: (candidate: string) => Promise<boolean>,
): Promise<void> {
  const quarantinePath = path.join(
    path.dirname(originalPath),
    `.${path.basename(originalPath)}.${crypto.randomUUID()}.pioneer-releasing`,
  );
  try {
    await rename(originalPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let owned: boolean;
  try {
    owned = await ownsPath(quarantinePath);
  } catch (error) {
    await restoreQuarantinedReviewReportPath(quarantinePath, originalPath);
    throw error;
  }
  if (owned) {
    await unlink(quarantinePath);
    return;
  }
  await restoreQuarantinedReviewReportPath(quarantinePath, originalPath);
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
  const publicationPath = reviewReportPublicationPath(target, reservationId);
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
    publicationPath,
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
      publicationPath,
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
  afterReportWrite: () => Promise<void> = async () => {},
  closePublishedHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void> = async (
    handle,
  ) => {
    await handle.close();
  },
): Promise<void> {
  if (reservation.state !== "reserved") {
    throw new Error(`Review report reservation is no longer active: ${reservation.target}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let publicationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  try {
    publicationHandle = await open(reservation.publicationPath, "wx", 0o600);
    await publicationHandle.writeFile(reservation.marker, "utf8");
    await publicationHandle.sync();
    await publicationHandle.close();
    publicationHandle = undefined;
    reservation.state = "publishing";
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
    await afterReportWrite();
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
    const publishedHandle = handle;
    handle = undefined;
    await closePublishedHandle(publishedHandle).catch(async () => {
      await publishedHandle.close().catch(() => {});
    });
    await removeOwnedReviewReportPath(
      reservation.reservationPath,
      async (candidate) => await ownsPublishedReviewReportFile(candidate, reservation, contents),
    ).catch(() => {});
    await removeOwnedReviewReportPath(
      reservation.publicationPath,
      async (candidate) => (await readFile(candidate, "utf8")) === reservation.marker,
    ).catch(() => {});
  } catch (error) {
    failure = error;
    if (handle !== undefined) {
      try {
        const marker = Buffer.from(reservation.marker, "utf8");
        let offset = 0;
        while (offset < marker.length) {
          const { bytesWritten } = await handle.write(
            marker,
            offset,
            marker.length - offset,
            offset,
          );
          if (bytesWritten <= 0) break;
          offset += bytesWritten;
        }
        if (offset === marker.length) {
          await handle.truncate(marker.length);
          await handle.sync();
        }
      } catch {
        // Preserve the publication failure; release uses the owned inode when available.
      }
    }
  }
  try {
    await handle?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await publicationHandle?.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

export async function releaseReviewReportReservation(
  reservation: ReviewReportReservation,
  afterOwnershipValidation: () => Promise<void> = async () => {},
): Promise<void> {
  if (reservation.state === "published" || reservation.state === "released") return;
  const targetStatsPromise =
    reservation.state === "publishing"
      ? ownedPublishingFileStats(reservation.target, reservation)
      : reservedTargetStats(reservation);
  const sidecarStatsPromise =
    reservation.state === "publishing"
      ? ownedPublishingFileStats(reservation.reservationPath, reservation)
      : reservedSidecarStats(reservation);
  const [targetStats, sidecarStats, publicationMarker] = await Promise.all([
    targetStatsPromise,
    sidecarStatsPromise,
    readPublicationMarker(reservation),
  ]);
  await afterOwnershipValidation();
  const ownsReservationFile = async (candidate: string): Promise<boolean> =>
    reservation.state === "publishing"
      ? (await ownedPublishingFileStats(candidate, reservation)) !== undefined
      : (await reservedFileStats(candidate, reservation)) !== undefined;
  if (targetStats !== undefined) {
    await removeOwnedReviewReportPath(reservation.target, ownsReservationFile);
  }
  if (sidecarStats !== undefined) {
    await removeOwnedReviewReportPath(reservation.reservationPath, ownsReservationFile);
  }
  if (publicationMarker === reservation.marker) {
    await removeOwnedReviewReportPath(
      reservation.publicationPath,
      async (candidate) => (await readFile(candidate, "utf8")) === reservation.marker,
    );
  }
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
