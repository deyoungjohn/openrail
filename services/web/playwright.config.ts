import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 360, height: 800 },
  },
  webServer: {
    command: `next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    env: { OPENRAIL_DEV_ROUTES: "1" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
