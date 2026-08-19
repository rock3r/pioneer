import { TEST_TEMP_ROOT_VARIABLE, useTestTempRoot } from "./temp-root.js";

/**
 * Workers are separate processes, so each one re-applies the root the global setup created.
 * Failing closed here matters more than convenience: a worker that silently kept the
 * operator's temporary directory would leak exactly what the containment exists to prevent.
 */
const root = process.env[TEST_TEMP_ROOT_VARIABLE];
if (root === undefined || root.length === 0) {
  throw new Error(
    `${TEST_TEMP_ROOT_VARIABLE} is not set. The unit suite must run through its global setup.`,
  );
}
useTestTempRoot(root);
