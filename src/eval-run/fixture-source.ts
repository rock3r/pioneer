import { constants } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { createFixtureContentScanner, fixtureContentLeakError } from "./fixture-leak.js";

const MIB = 1024 * 1024;

/**
 * Largest fixture `eval prepare` stages. Fixtures are small by design; a larger
 * file fails closed with `[EVAL_FIXTURE_TOO_LARGE]` instead of pressuring memory
 * or disk.
 */
export const EVAL_FIXTURE_MAX_BYTES = 64 * MIB;

const READ_CHUNK_BYTES = 64 * 1024;

/** The positional read that `FileHandle` provides, narrowed so tests can fake it. */
export interface EvalFixtureReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

/**
 * One opened fixture. Validation records its identity and closes it; staging
 * reopens it, requires the same identity, and rescans every byte it copies, so
 * a file swapped or edited after validation cannot land in `fixtures/`.
 */
export interface OpenedEvalFixture {
  /** Device, inode, size, and modification time of the opened file. */
  readonly identity: string;
  /** Rescans the opened file while copying it to a new destination. */
  stageTo(destination: string): Promise<void>;
  close(): Promise<void>;
}

function tooLargeError(relativePath: string, maxBytes: number): Error {
  const limit = maxBytes % MIB === 0 ? `${maxBytes / MIB} MiB` : `${maxBytes} bytes`;
  return new Error(`[EVAL_FIXTURE_TOO_LARGE] Fixture exceeds the ${limit} limit: ${relativePath}`);
}

/**
 * Streams a fixture from offset zero through the content-marker scanner. It
 * never reads more than one byte past `maxBytes`, so a file that grows after
 * `fstat` still fails closed. `write` receives each chunk only after that chunk
 * was scanned, and must finish with it before it resolves.
 */
export async function scanEvalFixture(
  reader: EvalFixtureReader,
  relativePath: string,
  maxBytes: number,
  write?: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  const scanner = createFixtureContentScanner();
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const length = Math.min(buffer.length, maxBytes + 1 - position);
    const { bytesRead } = await reader.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maxBytes) throw tooLargeError(relativePath, maxBytes);
    const chunk = buffer.subarray(0, bytesRead);
    const marker = scanner.push(chunk);
    if (marker !== undefined) throw fixtureContentLeakError(relativePath, marker);
    if (write !== undefined) await write(chunk);
  }
  const marker = scanner.end();
  if (marker !== undefined) throw fixtureContentLeakError(relativePath, marker);
}

async function writeFully(target: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

function changedError(relativePath: string): Error {
  return new Error(
    `[EVAL_FIXTURE_CHANGED] Fixture changed after validation; retry when it is stable: ${relativePath}`,
  );
}

async function fixtureIdentity(handle: FileHandle): Promise<string> {
  const details = await handle.stat({ bigint: true });
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeNs}`;
}

async function stageFromHandle(
  source: FileHandle,
  relativePath: string,
  maxBytes: number,
  mode: number,
  identity: string,
  destination: string,
): Promise<void> {
  let target: FileHandle;
  try {
    target = await open(destination, "wx", mode);
  } catch (error) {
    // Match the earlier non-forcing copy: an entry already staged at this path stays as it is.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    await scanEvalFixture(source, relativePath, maxBytes, (chunk) => writeFully(target, chunk));
    // An in-place edit during the copy could mix old and new bytes; refuse that copy.
    if ((await fixtureIdentity(source)) !== identity) throw changedError(relativePath);
    // The umask narrows the create mode; restore the source bits as a copy would.
    await target.chmod(mode);
  } catch (error) {
    await target.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
  await target.close();
}

/**
 * Opens a fixture once, requires a regular file within the size ceiling, and
 * scans its content for leaking markers. The caller must close the result.
 */
export async function openEvalFixture(
  canonicalPath: string,
  relativePath: string,
  maxBytes: number = EVAL_FIXTURE_MAX_BYTES,
  expectedIdentity?: string,
): Promise<OpenedEvalFixture> {
  // A link or FIFO swapped in after realpath must not be followed or block the open.
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  let mode: number;
  let identity: string;
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isFile()) {
      throw new Error(
        `Fixture is not a regular file (directories, FIFOs, and other special files are rejected): ${canonicalPath}`,
      );
    }
    if (details.size > BigInt(maxBytes)) throw tooLargeError(relativePath, maxBytes);
    identity = `${details.dev}:${details.ino}:${details.size}:${details.mtimeNs}`;
    if (expectedIdentity !== undefined && identity !== expectedIdentity) {
      throw changedError(relativePath);
    }
    // A reopened fixture is rescanned while it is staged, so only validation scans here.
    if (expectedIdentity === undefined) await scanEvalFixture(handle, relativePath, maxBytes);
    mode = Number(details.mode) & 0o777;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return {
    identity,
    stageTo: (destination) =>
      stageFromHandle(handle, relativePath, maxBytes, mode, identity, destination),
    close: () => handle.close(),
  };
}
