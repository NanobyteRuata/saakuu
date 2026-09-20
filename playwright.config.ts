import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The suite runs against `next dev` (the test email transport is refused in production), which compiles a route
  // on its first request; under parallel tests a single request can take several seconds.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  // Desktop Chrome defaults to exactly 1280, which is the two-pane threshold itself (docs/05 §0);
  // testing on the boundary is a flake waiting to happen.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  // Reuses a server already running (e.g. `docker compose up`); otherwise starts `next dev`.
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
