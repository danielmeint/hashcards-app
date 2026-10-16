import { defineConfig } from "vitest/config";
import { execSync } from "child_process";

const commitHash = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  root: ".",
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  test: {
    // `e2e/` and the README screenshots are Playwright's, and need a real browser.
    exclude: ["e2e/**", "scripts/screenshots/**", "node_modules/**"],
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
      },
    },
  },
});
