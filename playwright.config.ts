import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests (ROADMAP 3.5). Each runs the real app against a fake
 * GitHub (`e2e/fake-github.ts`), so they need no token and no network.
 *
 * Runs on the installed Google Chrome rather than a Playwright-downloaded
 * Chromium, so a Playwright upgrade never needs a browser download first.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5174",
    channel: "chrome",
    trace: "retain-on-failure",
    // A service worker's fetches bypass `page.route`, so with one installed the
    // fake GitHub would be skipped and real GitHub asked instead. Tests of the
    // worker itself opt back in.
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "phone", use: { ...devices["Pixel 7"], channel: "chrome" } },
  ],
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
  },
});
