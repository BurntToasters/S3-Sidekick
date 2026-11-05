import { defineConfig, devices } from "@playwright/test";

const jsonReportPath =
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ??
  "test-results/playwright-report.json";

export default defineConfig({
  // Bind the JSON evidence to the CI commit. Local runs may omit it; the
  // verifier compares whatever the report carries to GITHUB_SHA (H11).
  metadata: process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {},
  testDir: "./tests/browser",
  // Keep Playwright's automatic cleanup away from repeatable MinIO and script
  // E2E artifacts stored directly under test-results/.
  outputDir: "test-results/playwright",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // The release gate must see every test pass once. Retries would hide flakes;
  // scripts/verify-playwright-report.mjs rejects any retried result as well.
  retries: 0,
  failOnFlakyTests: Boolean(process.env.CI),
  workers: process.env.CI ? 1 : undefined,
  // The JSON file is the machine-checked evidence artifact. Configure it here
  // instead of relying on an environment variable Playwright does not read.
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: jsonReportPath }]]
    : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
