import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    execArgv:
      Number(process.versions.node.split(".")[0]) >= 25
        ? ["--no-webstorage"]
        : [],
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup/status-timer.ts"],
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
      // Aggregate floors plus per-module line ratchets (H11). The glob keys
      // are floors below each module's measured full-suite baseline, not
      // targets: raise them when coverage grows. Without these, a large
      // aggregate surplus can hide a regression in credential, grant, or
      // transfer code.
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 65,
        "src/app-connection.ts": { lines: 50 },
        "src/path-grants.ts": { lines: 35 },
        "src/transfer-state.ts": { lines: 50 },
      },
    },
  },
});
