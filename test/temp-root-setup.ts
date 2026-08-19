import { readdir, rm } from "node:fs/promises";
import {
  createTestTempRoot,
  TEST_TEMP_ROOT_VARIABLE,
  UNMANAGED_TEMP_ROOT_ENTRIES,
  useTestTempRoot,
} from "./support/temp-root.js";

/** Enough names to identify the responsible cases without flooding the failure output. */
const REPORTED_LEAK_LIMIT = 20;

/**
 * Points the whole unit suite at one run-scoped temporary root instead of the operator's
 * temporary directory, then removes it. Containment does not depend on a case remembering to
 * clean up, so it covers every way a temporary path can be created rather than only the
 * `mkdtemp` calls `temp-dir-hygiene.test.ts` can see in the sources.
 *
 * A non-empty root at teardown means something outlived the case that created it, so the run
 * fails rather than quietly reintroducing the leak this containment exists to prevent.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const root = await createTestTempRoot();
  process.env[TEST_TEMP_ROOT_VARIABLE] = root;
  useTestTempRoot(root);

  return async () => {
    const leaked = (await readdir(root)).filter(
      (entry) => !UNMANAGED_TEMP_ROOT_ENTRIES.includes(entry),
    );
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (leaked.length === 0) return;
    const named = leaked.slice(0, REPORTED_LEAK_LIMIT).sort().join(", ");
    const remainder = leaked.length > REPORTED_LEAK_LIMIT ? ", …" : "";
    process.exitCode = 1;
    console.error(
      `The unit suite left ${String(leaked.length)} temporary entries behind: ${named}${remainder}. ` +
        "Claim temporary paths through registerManagedTempPaths() in test/support/temp-dir.ts, " +
        "or, if they were already claimed, their removal failed while the platform still held them open.",
    );
  };
}
