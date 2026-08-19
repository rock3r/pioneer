import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export interface ManagedTempPaths {
  /** Creates one uniquely named directory under the platform temporary directory. */
  createTempDir(prefix: string): Promise<string>;
  /**
   * Names one path under the platform temporary directory without creating it, for cases
   * that hand the path to the code under test and let that code create the entry.
   */
  reserveTempPath(name: string): string;
}

/**
 * Removal is hygiene rather than an assertion, so a tree the platform still holds open
 * must never turn a passing case red. Windows reports transient sharing violations while
 * a handle closes, which the retries absorb.
 */
async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // The platform reclaims anything left behind; a failed removal is not a test result.
  }
}

/**
 * Registers an `afterEach` hook that removes every path the returned factories hand out,
 * so a suite never leaves temporary trees behind for the operator to clean up.
 *
 * Call this once at module or `describe` scope, because Vitest binds hooks while it
 * collects a file rather than while a case runs. Removal happens after the case that
 * claimed the path, so a case can still rely on its own temporary tree throughout.
 */
export function registerManagedTempPaths(): ManagedTempPaths {
  const claimed: string[] = [];

  afterEach(async () => {
    await Promise.all(claimed.splice(0).map(removeQuietly));
  });

  return {
    async createTempDir(prefix) {
      const root = await mkdtemp(path.join(tmpdir(), prefix));
      claimed.push(root);
      return root;
    },
    reserveTempPath(name) {
      const target = path.join(tmpdir(), name);
      claimed.push(target);
      return target;
    },
  };
}
