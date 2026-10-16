import type { ScheduleEvent } from "../../src/core/events";
import type { ParsedCard } from "../../src/types";
import { EXIT, UsageError } from "../command";
import type { Command } from "../command";
import { GRADE_NAMES, plural, table } from "../format";
import { eventDay, eventsByCard } from "../insights";
import { cardRef, openWorkspace } from "../workspace";

/** A card's two sides as a reviewer sees them. Cloze: the deletion hidden. */
export function sides(card: ParsedCard): { front: string; back: string } {
  if (card.content.type === "basic") return { front: card.content.question, back: card.content.answer };
  // start/end are byte offsets (inclusive) into the clean text.
  const bytes = new TextEncoder().encode(card.content.text);
  const dec = new TextDecoder();
  const { start, end } = card.content;
  const before = dec.decode(bytes.slice(0, start));
  const hidden = dec.decode(bytes.slice(start, end + 1));
  const after = dec.decode(bytes.slice(end + 1));
  return { front: `${before}[…]${after}`, back: `${before}[${hidden}]${after}` };
}

export const show: Command = {
  name: "show",
  summary: "one card: its text, file:line, state and review history",
  help: `Usage: hc show <file:line|key|hash-prefix>

  <file:line>  every card of the block at that line (a reverse card, every
               cloze deletion): geo/baltics.md:12
  <key>        a card key, h:0123abcd… (as hc due and hc add print them)
  <hash>       6+ hex digits of a card's key, or of its v1 content hash

History of a card that has been deleted is still shown: it is never removed.

Exit: 0 found, 1 no such card or history.`,
  options: {},
  positionals: 1,
  async run(ctx) {
    const query = ctx.positionals[0];
    if (!query) throw new UsageError("which card? give file:line or a key");
    const { collection, history, states, today } = await openWorkspace(ctx);
    const byCard = eventsByCard(history.events);

    const isHash = /^[0-9a-f]{6,64}$/.test(query);
    const at = /^(.+\.md):(\d+)$/.exec(query);
    const cards = collection.cards.filter(
      (c) =>
        c.key === query ||
        (isHash && (c.key.startsWith(`h:${query}`) || c.hash.startsWith(query))) ||
        (at !== null && c.filePath === at[1] && c.range[0] <= Number(at[2]) && c.range[1] >= Number(at[2]))
    );
    // History whose card is gone: by its exact key, or a prefix of it.
    const shown = new Set(cards.map((c) => c.key));
    const orphans = [...byCard.keys()].filter(
      (k) =>
        !shown.has(k) &&
        (k === query || (isHash && k.startsWith(`h:${query}`))) &&
        !collection.cards.some((c) => c.key === k)
    );

    const entries = [
      ...cards.map((card) => ({ key: card.key, card })),
      ...orphans.map((key) => ({ key, card: null as ParsedCard | null })),
    ].map(({ key, card }) => ({
      key,
      card,
      state: states.get(key) ?? null,
      events: byCard.get(key) ?? [],
    }));

    if (ctx.json) {
      ctx.emit({
        query,
        date: today,
        cards: entries.map(({ key, card, state, events }) => ({
          ...(card
            ? {
                ...cardRef(card),
                range: card.range,
                tags: card.tags,
                type: card.content.type,
                ...sides(card),
              }
            : { key, file: null, deleted: true }),
          state,
          history: events,
        })),
      });
    } else if (entries.length === 0) {
      ctx.io.stderr(`hc show: no card or history matches '${query}'\n`);
    } else {
      entries.forEach(({ key, card, state, events }, i) => {
        if (i > 0) ctx.say("\n" + "─".repeat(40));
        ctx.say(`${key}${card ? `  ${card.filePath}:${card.range[0]}-${card.range[1]}` : "  (deleted: history only)"}`);
        if (card) {
          const { front, back } = sides(card);
          ctx.say(
            table([
              ["deck", card.deckName],
              ["status", card.status],
              ["tags", card.tags.join(", ") || "–"],
            ])
          );
          ctx.say(`\n  Q: ${indent(front)}\n  A: ${indent(back)}`);
        }
        ctx.say(
          state
            ? `\n  due ${state.dueDate} · interval ${state.intervalDays}d · stability ${state.stability.toFixed(1)}d · difficulty ${state.difficulty.toFixed(2)} · ${plural(state.reviewCount, "review")}`
            : "\n  new: never reviewed"
        );
        if (events.length > 0) ctx.say(`\n  History\n${table(events.map(historyRow), "    ")}`);
      });
    }
    return entries.length > 0 ? EXIT.ok : EXIT.findings;
  },
};

function indent(text: string): string {
  return text.replace(/\n/g, "\n     ");
}

function historyRow(e: ScheduleEvent): string[] {
  const src = e.src ? `(${e.src})` : "";
  if (e.kind === "baseline") {
    return [eventDay(e), "baseline", `s=${e.s.toFixed(1)} d=${e.d.toFixed(2)} reps=${e.reps}`, src];
  }
  return [eventDay(e), GRADE_NAMES[e.grade], e.ms === undefined ? "" : `${(e.ms / 1000).toFixed(1)}s`, src];
}
