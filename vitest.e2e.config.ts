import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // End-to-end cases drive the built CLI and launch native sandboxes, so they run
    // serially with a generous per-case budget.
    fileParallelism: false,
    globalSetup: ["test/e2e/global-setup.ts"],
    hookTimeout: 120_000,
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
  },
});
