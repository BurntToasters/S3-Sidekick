import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/tests/**/*.test.ts"],
    // These suites are assertion-bound, not duration-bound: nothing here waits
    // on real I/O. The default 5s limit only ever expires when the machine is
    // starved of CPU (shared CI runners, parallel cargo builds), which turned
    // ordinary runs into false failures across unrelated files.
    testTimeout: 30000,
    hookTimeout: 30000,
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**", "src/vite-env.d.ts"],
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 65,
      },
    },
  },
});
