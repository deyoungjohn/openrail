import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/stack",
  outputDir: ".next/e2e-stack-results",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 900 },
    channel: "chromium",
  },
});
