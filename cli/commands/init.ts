import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDocFile, markdownFiles } from "../collection";
import { CONFIG_FILE, renderConfig } from "../config";
import { CommandError, EXIT } from "../command";
import type { Command } from "../command";

/**
 * The templates ship next to the code: `cli/templates/` from source,
 * `dist-cli/templates/` once built (the build copies them). Looked up rather
 * than imported so that `AGENTS.md` stays a plain Markdown file in the repo.
 */
function template(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "templates"), join(here, "..", "templates")]) {
    const path = join(dir, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new CommandError(`template ${name} is missing from this hc install`);
}

export const WORKFLOW_PATH = ".github/workflows/hashcards-lint.yml";

/**
 * The files `hc init` writes, and what goes in them. The `[decks] exclude`
 * list is whatever the default rule already treats as documentation in this
 * repo, so writing the config changes nothing about which files are decks.
 */
export function initFiles(repo: string): { path: string; text: string }[] {
  const docs = markdownFiles(repo).filter(isDocFile);
  const exclude = [...new Set(["README.md", "AGENTS.md", "CLAUDE.md", ...docs])];
  return [
    { path: CONFIG_FILE, text: renderConfig(exclude) },
    { path: "AGENTS.md", text: template("AGENTS.md") },
    { path: WORKFLOW_PATH, text: template("hashcards-lint.yml") },
  ];
}

export const init: Command = {
  name: "init",
  summary: "write hashcards.toml, AGENTS.md and a lint workflow",
  help: `Usage: hc init [--force]

Writes, in the repo:
  hashcards.toml                         collection settings, with defaults
  AGENTS.md                              how agents should write cards here
  ${WORKFLOW_PATH}   runs \`hc lint\` on pull requests

An existing file is left alone and reported as skipped, unless --force.

Options:
  --force   overwrite existing files`,
  options: { force: { type: "boolean" } },
  async run(ctx) {
    const written: string[] = [];
    const skipped: string[] = [];
    for (const { path, text } of initFiles(ctx.repo)) {
      const full = join(ctx.repo, path);
      if (existsSync(full) && !ctx.values.force) {
        skipped.push(path);
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
      written.push(path);
    }
    if (ctx.json) ctx.emit({ written, skipped });
    else {
      for (const p of written) ctx.say(`wrote ${p}`);
      for (const p of skipped) ctx.say(`skipped ${p}: exists (--force to overwrite)`);
      if (written.includes("AGENTS.md")) ctx.say("\nNext: read AGENTS.md, then `hc add` cards and `hc lint`.");
    }
    return EXIT.ok;
  },
};
