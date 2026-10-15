import { defineConfig } from "vite";
import { chmodSync, cpSync } from "node:fs";

/**
 * The `hc` CLI as one Node file, `dist-cli/hc.js`, with its dependencies
 * (ts-fsrs) bundled in, so the published package needs nothing at runtime.
 * `cli/templates/` is copied next to it, where `hc init` looks for them.
 */
export default defineConfig({
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: "cli/hc.ts",
    outDir: "dist-cli",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "hc.js",
        banner: "#!/usr/bin/env node",
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [
    {
      name: "hc-templates",
      closeBundle() {
        cpSync("cli/templates", "dist-cli/templates", { recursive: true });
        chmodSync("dist-cli/hc.js", 0o755);
      },
    },
  ],
});
