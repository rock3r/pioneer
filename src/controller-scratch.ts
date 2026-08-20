import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isBroadWritablePath } from "./eval-run/isolation.js";

/**
 * `sun_path` bounds a Unix socket path at 108 bytes on Linux. The proxy bridge binds
 * `<base>/pir-bridge-XXXXXX/proxy.sock`, 29 of those bytes, so a base too long to host it is
 * rejected where the base is chosen rather than with an `EINVAL` later at bind time.
 *
 * Only Linux launches that bridge, so only Linux carries the reserve. Enforcing it on macOS
 * would reject bases that platform can use perfectly well, because nothing binds a socket
 * below the controller scratch base there.
 */
const LINUX_UNIX_SOCKET_PATH_LIMIT = 108;
const BRIDGE_SOCKET_RESERVE = 32;

/**
 * Validates a caller-supplied controller scratch base and returns its canonical path.
 *
 * Pioneer's own default is deliberately short and is never routed through here, so an absent
 * override leaves production allocation byte-identical. An override is held to the same
 * standard as a writable run directory: it must already exist as a real directory, and it must
 * not be a broad or protected system location, because the actor's write grants follow it.
 */
export async function validateControllerScratchBase(
  requested: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!path.isAbsolute(requested)) {
    throw new Error(`Controller scratch base must be an absolute path: ${requested}`);
  }

  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new Error(`Controller scratch base does not exist: ${requested}`);
  }

  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new Error(`Controller scratch base is not a directory: ${requested}`);
  }

  if (isBroadWritablePath(canonical, platform)) {
    throw new Error(
      `Controller scratch base must not be a broad or protected location: ${canonical}`,
    );
  }

  assertScratchBaseNotReplaceable(canonical, details, platform);

  const socketFailure = controllerScratchSocketFailure(canonical, platform);
  if (socketFailure !== undefined) throw new Error(socketFailure);

  return canonical;
}

/**
 * Reports why a base cannot host the proxy bridge socket, or `undefined` when it can. Kept
 * separate from the filesystem checks so the byte budget is verifiable without a fixture whose
 * own location would dominate the measurement.
 */
export function controllerScratchSocketFailure(
  canonical: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "linux") return undefined;
  const headroom = LINUX_UNIX_SOCKET_PATH_LIMIT - Buffer.byteLength(canonical);
  if (headroom >= BRIDGE_SOCKET_RESERVE) return undefined;
  return (
    `Controller scratch base ${canonical} leaves ${String(headroom)} bytes for the proxy ` +
    `bridge socket, below the ${String(BRIDGE_SOCKET_RESERVE)} it needs.`
  );
}

/**
 * Refuses a base that another local principal could tamper with.
 *
 * A directory other users may write to lets one of them rename the freshly created scratch
 * directory away and leave a symlink in its place between creation and adoption. The runner
 * would then write the Pi configuration snapshot through that link and recursively remove the
 * link's target during cleanup, which turns an unprivileged local user into a credential
 * disclosure and arbitrary-deletion primitive. The sticky bit is what makes a shared temporary
 * directory safe, and is why Pioneer's own default of `/tmp` at mode 1777 is not affected.
 */
function assertScratchBaseNotReplaceable(
  canonical: string,
  details: Stats,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") return;

  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && details.uid !== currentUid) {
    throw new Error(`Controller scratch base must be owned by this user: ${canonical}`);
  }

  const writableByOthers = (details.mode & 0o022) !== 0;
  const sticky = (details.mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) {
    throw new Error(
      `Controller scratch base is writable by other users without the sticky bit: ${canonical}`,
    );
  }
}

/**
 * Adopts a scratch directory the controller just created, refusing a substitution.
 *
 * `realpath` alone would follow a symlink left in place of the created directory, so the entry
 * is inspected without following links first and its resolved path must be the path that was
 * created. Cheap belt-and-braces behind the base checks, because it closes the window even on a
 * sticky shared base where a rename is supposed to be impossible.
 */
export async function adoptCreatedScratchDirectory(created: string): Promise<string> {
  const entry = await lstat(created);
  if (!entry.isDirectory()) {
    throw new Error(`Controller scratch directory was replaced after creation: ${created}`);
  }
  // Compare against the canonical parent rather than the literal path, because a caller's base
  // need not be canonical: on macOS `/var` is a symlink to `/private/var`, so an honest
  // directory there resolves to a different string than the one just created.
  const canonical = await realpath(created);
  const expected = path.join(await realpath(path.dirname(created)), path.basename(created));
  if (canonical !== expected) {
    throw new Error(`Controller scratch directory was replaced after creation: ${created}`);
  }
  return canonical;
}
