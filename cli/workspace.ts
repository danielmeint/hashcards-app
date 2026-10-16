import { addDays } from "../src/core/schedule";
import type { CardState } from "../src/core/replay";
import { localDay } from "../src/fsrs";
import type { ParsedCard } from "../src/types";
import { loadCollection } from "./collection";
import type { Collection } from "./collection";
import { loadHistory, replayHistory } from "./history";
import type { History } from "./history";
import { UsageError } from "./command";
import type { Context } from "./command";

/**
 * Everything the read commands (`due`, `stats`, `leeches`, `show`) share: the
 * collection, its history replayed, and which day "today" is.
 */
export type Workspace = {
  collection: Collection;
  history: History;
  states: Map<string, CardState>;
  today: string;
};

export async function openWorkspace(ctx: Context): Promise<Workspace> {
  const collection = await loadCollection(ctx.repo);
  const history = loadHistory(ctx.repo, collection.cards);
  const states = replayHistory(history, collection.config.config);
  const date = ctx.values.date;
  const today = parseDate(typeof date === "string" ? date : undefined, localDay(ctx.io.now()));
  return { collection, history, states, today };
}

/**
 * `--date`: `YYYY-MM-DD`, `today`, `tomorrow` or `+N` days. Days are the
 * machine's local days, as the app counts them.
 */
export function parseDate(value: string | undefined, today: string): string {
  if (value === undefined || value === "today") return today;
  if (value === "tomorrow") return addDays(today, 1);
  const rel = value.match(/^\+(\d+)$/);
  if (rel) return addDays(today, Number(rel[1]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z"))) {
    return value;
  }
  throw new UsageError(`--date must be YYYY-MM-DD, today, tomorrow or +N, not '${value}'`);
}

/** Cards that are scheduled: not drafts, not suspended. */
export function activeCards(collection: Collection): ParsedCard[] {
  return collection.cards.filter((c) => c.status === "active");
}

/** A card as `due`, `leeches` and `show` list it in JSON. */
export function cardRef(card: ParsedCard) {
  return {
    key: card.key,
    file: card.filePath,
    line: card.range[0],
    deck: card.deckName,
    status: card.status,
  };
}
