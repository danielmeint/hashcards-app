import { defineConfig } from "@playwright/test";

/**
 * `npm run screenshots`: the README's pictures, taken from the demo. Kept out
 * of the e2e suite (its own testDir), since it writes into docs/ rather than
 * asserting anything.
 */
const port = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: ".",
  reporter: "list",
  workers: 1,
  use: {
    baseURL: `http://localhost:${port}`,
    channel: "chrome",
    serviceWorkers: "block",
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
