import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomId, stampIds } from "../../src/card-ids";
import { loadCollection } from "../collection";
import type { Collection, Problem } from "../collection";
import { EXIT } from "../command";
import type { Command } from "../command";
import { plural } from "../format";

/**
 * Validate every deck; with `--fix`, stamp IDs onto cards that lack one.
 *
 * Errors (exit 1): a file that does not parse, a bad `hashcards.toml`, an ID
 * used in two files. Warnings (exit 0, or 1 with `--strict`): cards without an
 * ID — legal, since agents may leave IDs out, but their history is keyed by
 * content until one is stamped.
 *
 * Duplicate IDs are never fixed automatically: one of the two cards owns the
 * history and the other must be renamed, and only a person knows which.
 */
export const lint: Command = {
  name: "lint",
  summary: "check every deck; --fix stamps missing IDs",
  help: `Usage: hc lint [--fix] [--strict]

Parses every deck file and reports, with file:line:
  errors    files that do not parse, a bad hashcards.toml, an ID used twice
  warnings  cards without an ID

Which files are decks: hashcards.toml [decks] include/exclude globs if present,
otherwise every *.md except README, AGENTS, CLAUDE, CHANGELOG, LICENSE and
other all-caps documentation (CARD_GUIDE.md), and nothing in hidden directories.

Options:
  --fix      add an ID to every card that has none, unique across the collection.
             Changes nothing else in the file. Files with errors are left alone.
  --strict   exit 1 on warnings too

Exit: 0 clean, 1 errors (or warnings with --strict), 2 usage.`,
  options: {
    fix: { type: "boolean" },
    strict: { type: "boolean" },
  },
  async run(ctx) {
    let collection = await loadCollection(ctx.repo);
    const fixed: { file: string; stamped: number }[] = [];

    if (ctx.values.fix) {
      fixed.push(...stampMissing(collection));
      if (fixed.length > 0) collection = await loadCollection(ctx.repo);
    }

    const errors = collection.problems.filter((p) => p.severity === "error");
    const warnings = collection.problems.filter((p) => p.severity === "warning");
    const failed = errors.length > 0 || (ctx.values.strict === true && warnings.length > 0);

    if (ctx.io.env.GITHUB_ACTIONS === "true") annotate(ctx.io.stdout, collection.problems);

    if (ctx.json) {
      ctx.emit({
        ok: !failed,
        files: collection.files.length,
        cards: collection.cards.length,
        errors,
        warnings,
        fixed,
      });
    } else {
      for (const f of fixed) ctx.say(`fixed ${f.file}: stamped ${plural(f.stamped, "ID")}`);
      for (const p of [...errors, ...warnings]) ctx.say(formatProblem(p));
      const missing = warnings.filter((w) => w.kind === "missing-id").length;
      ctx.say(
        `${plural(collection.files.length, "deck file")}, ${plural(collection.cards.length, "card")}: ` +
          `${plural(errors.length, "error")}, ${plural(warnings.length, "warning")}` +
          (missing > 0 && !ctx.values.fix ? ` (run \`hc lint --fix\` to stamp ${plural(missing, "ID")})` : "")
      );
    }
    return failed ? EXIT.findings : EXIT.ok;
  },
};

export function formatProblem(p: Problem): string {
  const where = p.line === null ? p.file : `${p.file}:${p.line}`;
  return `${where}: ${p.severity}: ${p.message}`;
}

/** `::error file=…` lines, which GitHub turns into annotations on the PR diff. */
function annotate(write: (text: string) => void, problems: Problem[]): void {
  for (const p of problems) {
    const level = p.severity === "error" ? "error" : "warning";
    const line = p.line === null ? "" : `,line=${p.line}`;
    write(`::${level} file=${p.file}${line}::${p.message.replace(/\r?\n/g, " ")}\n`);
  }
}

/**
 * Stamp every parseable file that has cards without IDs. New IDs avoid every
 * ID in the collection, including those in files that do not parse and those
 * stamped earlier in this run, so the result is unique collection-wide.
 */
export function stampMissing(
  collection: Collection,
  generate: () => string = randomId
): { file: string; stamped: number }[] {
  const taken = new Set(collection.ids.keys());
  const unique = () => {
    // Bounded, so a broken generator fails rather than hangs.
    for (let i = 0; i < 100; i++) {
      const id = generate();
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new Error("could not generate an unused card ID in 100 attempts");
  };
  const needing = new Set(
    collection.problems.filter((p) => p.kind === "missing-id").map((p) => p.file)
  );
  const fixed: { file: string; stamped: number }[] = [];
  for (const file of collection.files) {
    if (!needing.has(file.path) || file.cards === null) continue;
    let stamped = 0;
    const text = stampIds(
      file.text,
      () => {
        stamped++;
        return unique();
      },
      file.path
    );
    if (text !== file.text) {
      writeFileSync(join(collection.root, file.path), text);
      fixed.push({ file: file.path, stamped });
    }
  }
  return fixed;
}
