import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Carries the run-scoped root from the global setup to every worker process. */
export const TEST_TEMP_ROOT_VARIABLE = "PIONEER_TEST_TEMP_ROOT";

/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, and a Unix socket bound anywhere below
 * the run root has to fit. The longest one the suite binds is `/pioneer-bridge-test-XXXXXX/
 * proxy.sock` at 38 bytes, so the reserve keeps a small margin above it and an over-long root
 * fails with an explanation instead of the `EINVAL` a caller would otherwise have to decode.
 * A longer socket path needs this raised, which in turn demands a shorter `TMPDIR`: the
 * default macOS per-user directory already spends 48 of the 104 bytes on its own.
 */
const UNIX_SOCKET_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
const UNIX_SOCKET_PATH_RESERVE = 40;

/**
 * Entries the platform or the runtime owns. They appear inside the run root without any
 * case creating them, so leak detection must not attribute them to the suite.
 */
export const UNMANAGED_TEMP_ROOT_ENTRIES: readonly string[] = ["node-compile-cache"];

/**
 * Creates the run-scoped root that every worker uses as its temporary directory. The name is
 * deliberately short because the whole point is to prefix every temporary path in the suite.
 */
export async function createTestTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pio-"));
  const headroom = UNIX_SOCKET_PATH_LIMIT - Buffer.byteLength(root);
  if (headroom < UNIX_SOCKET_PATH_RESERVE) {
    throw new Error(
      `Test temporary root ${root} leaves ${String(headroom)} bytes for Unix socket paths, ` +
        `below the ${String(UNIX_SOCKET_PATH_RESERVE)} a case may need. ` +
        "Point TMPDIR at a shorter directory before running the suite.",
    );
  }
  return root;
}

/** Redirects this process's temporary directory, covering the POSIX and Windows variables. */
export function useTestTempRoot(root: string): void {
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;
}
