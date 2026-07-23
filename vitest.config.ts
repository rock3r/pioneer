import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
