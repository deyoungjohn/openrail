import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  testIgnore: ["stack/**"],
  // Under .next so git, eslint and prettier already ignore it.
  outputDir: ".next/e2e-results",
  fullyParallel: true,
  // The gallery page is heavy; eight workers made axe and first paint time out on a laptop.
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 360, height: 800 },
    // The pre-installed browser is full Chromium, not the headless shell.
    channel: "chromium",
  },
  webServer: [
    {
      command: `next start -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      env: { OPENRAIL_DEV_ROUTES: "1" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The S1a mock API: fixtures/api/ over HTTP, with credentialed CORS for the web origin.
      // Tests that intercept the API with page.route never reach it.
      command: "pnpm exec tsx ../api/src/server.ts",
      url: "http://127.0.0.1:8787/v1/routes",
      env: { MOCK: "1", WEB_ORIGIN: `http://127.0.0.1:${PORT}`, API_PORT: "8787" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
