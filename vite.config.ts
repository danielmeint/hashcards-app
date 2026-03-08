import { defineConfig } from "vite";
import { execSync } from "child_process";

const commitHash = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  root: ".",
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
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
