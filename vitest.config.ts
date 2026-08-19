import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    globalSetup: ["test/global-setup.ts", "test/temp-root-setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["test/support/temp-root-worker.ts"],
  },
});
