import { LEECH_THRESHOLD } from "../../src/leeches";
import { EXIT, UsageError } from "../command";
import type { Command } from "../command";
import { plural, summary, table } from "../format";
import { eventsByCard, leeches as findLeeches } from "../insights";
import { cardRef, openWorkspace } from "../workspace";

export const leeches: Command = {
  name: "leeches",
  summary: "cards that keep failing, from the full review history",
  help: `Usage: hc leeches [--min-lapses N] [--all]

Cards with at least N lapses (reviews graded Forgot; default ${LEECH_THRESHOLD}), still-failing
first, then by lapses. A card answered right 3 times running since its last
lapse is marked recovering. A leech is usually a badly written card: two facts
in one, an ambiguous answer, a cloze with no cue.

Options:
  --min-lapses <n>   threshold (default ${LEECH_THRESHOLD})
  --all              include history of cards no longer in the collection

Exit: 0 none, 1 leeches found.`,
  options: {
    "min-lapses": { type: "string" },
    all: { type: "boolean" },
  },
  async run(ctx) {
    const raw = ctx.values["min-lapses"];
    const threshold = raw === undefined ? LEECH_THRESHOLD : Number(raw);
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new UsageError(`--min-lapses must be a whole number ≥ 1, not '${raw}'`);
    }
    const { collection, history } = await openWorkspace(ctx);
    const byKey = new Map(collection.cards.map((c) => [c.key, c]));
    const found = findLeeches(eventsByCard(history.events), threshold)
      .map((l) => ({ ...l, card: byKey.get(l.key) ?? null }))
      .filter((l) => l.card !== null || ctx.values.all);

    if (ctx.json) {
      ctx.emit({
        minLapses: threshold,
        leeches: found.map(({ card, ...l }) => ({
          ...l,
          ...(card ? { ...cardRef(card), summary: summary(card, 200) } : { file: null, line: null }),
        })),
      });
    } else if (found.length === 0) {
      ctx.say(`no leeches (no card with ${threshold}+ lapses)`);
    } else {
      ctx.say(`${plural(found.length, "leech", "leeches")} (${threshold}+ lapses)`);
      ctx.say(
        table([
          ["lapses", "reviews", "key", "where", "card"],
          ...found.map((l) => [
            `${l.lapses}${l.recovering ? " ↻" : ""}`,
            String(l.reviews),
            l.key,
            l.card ? `${l.card.filePath}:${l.card.range[0]}` : "(deleted)",
            l.card ? summary(l.card, 50) : "",
          ]),
        ])
      );
      if (found.some((l) => l.recovering)) ctx.say("↻ recovering: passed 3+ times since the last lapse");
    }
    return found.length > 0 ? EXIT.findings : EXIT.ok;
  },
};
