import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["../tests/**/*.test.ts"],
    exclude: ["../tests/manual-smoke.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
    },
  },
});
