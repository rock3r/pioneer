import { realpath, stat } from "node:fs/promises";
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
