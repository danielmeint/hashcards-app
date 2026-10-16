import { loadCollection } from "../collection";
import type { Problem } from "../collection";
import { EXIT } from "../command";
import type { Command } from "../command";
import { plural } from "../format";

/**
 * Validate every deck.
 *
 * Errors (exit 1): a file that does not parse, a bad `hashcards.toml`.
 * Warnings (exit 0, or 1 with `--strict`): the same card twice (PLAN-1.0
 * §2.7: same text, so one card and one schedule), and `ID:` lines left from
 * early 1.0 builds.
 */
export const lint: Command = {
  name: "lint",
  summary: "check every deck",
  help: `Usage: hc lint [--strict]

Parses every deck file and reports, with file:line:
  errors    files that do not parse, a bad hashcards.toml
  warnings  the same card twice (same text, whitespace aside: one card, one
            schedule), and ID: lines from early 1.0 builds (\`hc migrate\`
            removes them and keeps their history)

Which files are decks: hashcards.toml [decks] include/exclude globs if present,
otherwise every *.md except README, AGENTS, CLAUDE, CHANGELOG, LICENSE and
other all-caps documentation (CARD_GUIDE.md), and nothing in hidden directories.

Options:
  --strict   exit 1 on warnings too

Exit: 0 clean, 1 errors (or warnings with --strict), 2 usage.`,
  options: {
    strict: { type: "boolean" },
  },
  async run(ctx) {
    const collection = await loadCollection(ctx.repo);
    const errors = collection.problems.filter((p) => p.severity === "error");
    const warnings = collection.problems.filter((p) => p.severity === "warning");
    const failed = errors.length > 0 || (ctx.values.strict === true && warnings.length > 0);

    // Annotations are lines on stdout, so not under --json, whose stdout is
    // one JSON document.
    if (ctx.io.env.GITHUB_ACTIONS === "true" && !ctx.json) annotate(ctx.io.stdout, collection.problems);

    if (ctx.json) {
      ctx.emit({
        ok: !failed,
        files: collection.files.length,
        cards: collection.cards.length,
        errors,
        warnings,
      });
    } else {
      for (const p of [...errors, ...warnings]) ctx.say(formatProblem(p));
      ctx.say(
        `${plural(collection.files.length, "deck file")}, ${plural(collection.cards.length, "card")}: ` +
          `${plural(errors.length, "error")}, ${plural(warnings.length, "warning")}`
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
