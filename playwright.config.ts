import { defineConfig, devices } from "@playwright/test";

// The tests need the dev server and a seeded database (npm run db:up, db:setup).
// Reuses a server that is already running on port 3000.
const APP_URL = "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: APP_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
