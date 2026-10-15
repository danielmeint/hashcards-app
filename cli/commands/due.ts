import { daysBetween } from "../../src/core/schedule";
import { EXIT } from "../command";
import type { Command } from "../command";
import { plural, summary, table } from "../format";
import { describeSource } from "../history";
import { eventsByCard, introducedOn } from "../insights";
import { activeCards, cardRef, openWorkspace } from "../workspace";

export const due: Command = {
  name: "due",
  summary: "reviews due and new cards available today",
  help: `Usage: hc due [--date YYYY-MM-DD|tomorrow|+N] [--limit N]

Reviews due on the date (overdue included) and the new cards that the day's
budget (hashcards.toml [review] new_per_day, minus new cards already started
that day according to the review log) still allows. Drafts and suspended cards
are never due.

Options:
  --date <day>   the day to evaluate; default: today (local time)
  --limit <n>    cards listed per section in human output (default 10; JSON lists all)`,
  options: {
    date: { type: "string" },
    limit: { type: "string" },
  },
  async run(ctx) {
    const { collection, history, states, today } = await openWorkspace(ctx);
    const cards = activeCards(collection);
    const perDay = collection.config.config.review.newPerDay;
    const introduced = introducedOn(eventsByCard(history.events), today);
    const budget = Math.max(0, perDay - introduced);

    const dueCards = cards
      .map((card) => ({ card, state: states.get(card.key) }))
      .filter(({ state }) => state && state.dueDate <= today)
      .sort((a, b) => a.state!.dueDate.localeCompare(b.state!.dueDate));
    const unseen = cards.filter((card) => !states.has(card.key));
    const newCards = unseen.slice(0, budget);

    if (ctx.json) {
      ctx.emit({
        date: today,
        history: history.source,
        reviews: {
          count: dueCards.length,
          cards: dueCards.map(({ card, state }) => ({
            ...cardRef(card),
            due: state!.dueDate,
            overdueDays: daysBetween(state!.dueDate, today),
            summary: summary(card, 200),
          })),
        },
        new: {
          count: newCards.length,
          unseen: unseen.length,
          perDay,
          introducedToday: introduced,
          cards: newCards.map((card) => ({ ...cardRef(card), summary: summary(card, 200) })),
        },
        warnings: [...history.warnings, ...collection.problems.filter((p) => p.severity === "error").map((p) => `${p.file}:${p.line ?? ""} ${p.message}`)],
      });
      return EXIT.ok;
    }

    const limit = Number(ctx.values.limit ?? 10) || 10;
    ctx.say(
      `${today}: ${plural(dueCards.length, "review")} due, ${newCards.length} new ` +
        `(${unseen.length} unseen; ${introduced}/${perDay} new started today)`
    );
    ctx.say(`history: ${describeSource(history.source)}`);
    const section = (title: string, rows: string[][], total: number) => {
      if (total === 0) return;
      ctx.say(`\n${title}`);
      ctx.say(table(rows));
      if (total > rows.length) ctx.say(`  … and ${total - rows.length} more (--limit, or --json for all)`);
    };
    section(
      "Due",
      dueCards.slice(0, limit).map(({ card, state }) => {
        const late = daysBetween(state!.dueDate, today);
        return [late > 0 ? `+${late}d` : "today", card.key, `${card.filePath}:${card.range[0]}`, summary(card, 60)];
      }),
      dueCards.length
    );
    section(
      "New",
      newCards.slice(0, limit).map((card) => [card.key, `${card.filePath}:${card.range[0]}`, summary(card, 60)]),
      newCards.length
    );
    const broken = collection.problems.filter((p) => p.severity === "error").length;
    if (broken > 0) ctx.say(`\nnote: ${plural(broken, "lint error")} (cards in broken files are left out); run \`hc lint\``);
    for (const w of history.warnings.slice(0, 5)) ctx.io.stderr(`warning: ${w}\n`);
    return EXIT.ok;
  },
};
