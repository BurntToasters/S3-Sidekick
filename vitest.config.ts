import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/tests/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
  },
});
