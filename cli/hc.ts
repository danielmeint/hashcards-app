/**
 * `hc`, the hashcards command line (PLAN-1.0 M5).
 *
 * This file is the only one Node loads on its own. Run from source
 * (`node cli/hc.ts`), the modules behind it — `src/parser.ts` and friends —
 * are written for a bundler: extensionless imports, a TypeScript `enum`, type
 * imports not marked `import type`. Node's built-in type stripping refuses all
 * three, so a source run first installs a small loader that compiles them.
 * The built `dist-cli/hc.js` is one bundled file and skips that step.
 */
if (import.meta.url.endsWith(".ts")) {
  // A variable, so the bundler leaves the dev loader out of `dist-cli`.
  const loader = "./dev-loader.ts";
  await import(loader);
}

const { main } = await import("./main");
process.exitCode = await main(process.argv.slice(2));
