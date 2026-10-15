import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Lets `node cli/hc.ts` run the app's TypeScript as it is.
 *
 * Node 22+ strips types natively, but only from files written for it: explicit
 * `.ts` extensions, no enums, `import type` for types. `src/` is written for
 * Vite instead, and rewriting it would collide with everything else changing
 * there. So imports without an extension are resolved to `.ts`, and `.ts`
 * files are compiled with esbuild — already installed as Vite's own compiler —
 * which elides type-only imports and compiles enums.
 *
 * Development only: the built CLI is bundled and never loads this.
 */
type Esbuild = {
  transformSync(
    code: string,
    options: { loader: "ts"; format: "esm"; target: string; sourcefile: string }
  ): { code: string };
};
const esbuild = createRequire(import.meta.url)("esbuild") as Esbuild;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      const missing = (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND";
      if (relative && missing && !/\.[a-z]+$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    const { code } = esbuild.transformSync(readFileSync(path, "utf8"), {
      loader: "ts",
      format: "esm",
      target: "node22",
      sourcefile: path,
    });
    return { format: "module", source: code, shortCircuit: true };
  },
});
