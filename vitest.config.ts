import { configDefaults, defineConfig } from "vitest/config";

const windowsUnitTests = process.platform === "win32";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    ...(windowsUnitTests
      ? {
          // Windows runners oversubscribe filesystem-heavy files. Serialize them
          // and give each case modest headroom instead of hiding hangs behind a
          // large global timeout.
          fileParallelism: false,
          hookTimeout: 15_000,
          maxWorkers: 1,
          testTimeout: 15_000,
        }
      : {}),
  },
});
