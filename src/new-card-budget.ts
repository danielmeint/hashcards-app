import { Card, ReviewedPerformance } from "./types";
import { todayStr } from "./fsrs";
import { legacy, settings } from "./settings";
import { startedOn } from "./review-state";
import { markDirty } from "./collection-settings";
import { getAllDeckFiles, stateKey } from "./db";
import { NewCardBudget, NewCardLimit, budgetFor, newCardBudget, pickNew } from "./core/limits";

// --- Settings ---

export function getNewCardsPerDay(): number {
  return settings.newCardsPerDay.get();
}

/** A collection setting: written to `hashcards.toml` on the next sync. */
export function setNewCardsPerDay(n: number): void {
  settings.newCardsPerDay.set(n);
  markDirty("newPerDay");
}

// --- Today's budget ---

/*
 * The budget is one per collection (`hashcards.toml`), so what it is spent
 * against is too: the cards first graded today on any device, worked out from
 * the merged log (`startedOn`), as `hc due` does. It used to be a counter in
 * this device's localStorage, so a phone that had started twenty new cards
 * left the desktop offering twenty more.
 *
 * `[limits.<name>]` groups split it further (`core/limits.ts`): each started
 * card is kept with its deck's path, so a group's spend is the started cards
 * in its decks.
 *
 * The log is read asynchronously and the budget is asked synchronously (the
 * deck list, the drill), so the answer is kept here: refreshed whenever the
 * deck list loads, and kept current between refreshes by the drill, which
 * reports each first grade and each undo of one as it happens.
 */
let started: { date: string; paths: Map<string, string | null> } | null = null;

/** The collection's new-card groups, as last read from `hashcards.toml`. */
export function getNewCardLimits(): NewCardLimit[] {
  return settings.newCardLimits.get();
}

/**
 * Re-read today's started cards from the log. `cards` say which deck each one
 * is in; without them the deck store is read.
 */
export async function refreshIntroduced(
  today: string = todayStr(),
  cards?: Card[]
): Promise<void> {
  const keys = await startedOn(today);
  const pathOf = await deckPaths(cards);
  started = { date: today, paths: new Map([...keys].map((k) => [k, pathOf.get(k) ?? null])) };
  // The counter this replaced; its count would read as a reset here.
  legacy.introducedToday.remove();
}

async function deckPaths(cards?: Card[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const add = (key: string, path: string) => {
    if (!paths.has(key)) paths.set(key, path);
  };
  if (cards) {
    for (const card of cards) add(stateKey(card), card.filePath);
  } else {
    for (const file of await getAllDeckFiles()) {
      for (const card of file.cards) add(stateKey({ ...card, repo: file.repo }), file.path);
    }
  }
  return paths;
}

/** The deck path of each card started today, since this device's last Reset. */
function startedToday(today: string): (string | null)[] {
  if (started?.date !== today) return [];
  const reset = settings.newCardsReset.get();
  const entries = [...started.paths];
  if (reset?.date !== today) return entries.map(([, path]) => path);
  // A reset from before groups knew only how many.
  if (!reset.keys) return entries.slice(reset.count).map(([, path]) => path);
  const before = new Set(reset.keys);
  return entries.filter(([key]) => !before.has(key)).map(([, path]) => path);
}

export function getIntroducedToday(today: string = todayStr()): number {
  return startedToday(today).length;
}

/** What today's new cards may still use, the collection's and each group's. */
export function getBudget(today: string = todayStr()): NewCardBudget {
  return newCardBudget(getNewCardsPerDay(), getNewCardLimits(), startedToday(today));
}

/** The collection's budget left today, whatever the groups say. */
export function remainingBudget(today: string = todayStr()): number {
  return getBudget(today).total;
}

/** New cards a deck at `path` may still introduce today: its group's budget within the collection's. */
export function remainingFor(path: string, today: string = todayStr()): number {
  return budgetFor(path, getBudget(today));
}

/**
 * The drill graded `key` (in the deck at `path`) for the first time, or undid
 * that grade.
 */
export function recordIntroduced(
  today: string,
  key: string,
  first: boolean,
  path: string | null = null
): void {
  if (started?.date !== today) started = { date: today, paths: new Map() };
  if (first) started.paths.set(key, path);
  else started.paths.delete(key);
}

/**
 * "Reset" in Settings: today's count starts again from zero on this device,
 * every group's with it. Local on purpose — it is a choice to do more today
 * here, not a setting.
 */
export function resetIntroduced(today: string = todayStr()): void {
  const keys = started?.date === today ? [...started.paths.keys()] : [];
  settings.newCardsReset.set({ date: today, count: keys.length, keys });
}

// --- Card classification ---

/**
 * Select review-due and budget-capped new cards from a list: new cards in the
 * order given, each while its group and the collection both have budget left.
 */
export function selectDueCards(
  cards: Card[],
  performances: Map<string, ReviewedPerformance>,
  today: string = todayStr()
): Card[] {
  const budget = getBudget(today);
  const reviewDue: Card[] = [];
  const newCards: Card[] = [];

  for (const card of cards) {
    // A draft is a proposal, a suspended card is set aside: neither is due,
    // and neither is offered as new.
    if (card.status === "draft" || card.status === "suspended") continue;
    const perf = performances.get(stateKey(card));
    if (!perf) {
      newCards.push(card);
    } else if (perf.dueDate <= today) {
      reviewDue.push(card);
    }
  }

  return [...reviewDue, ...pickNew(newCards, (card) => card.filePath, budget)];
}

/**
 * Count review-due and unseen cards in a set.
 *
 * `newCount` is the raw supply, *not* capped by the day's budget. The budget is
 * a single global pool, so a caller counting several decks must clamp once
 * across all of them — clamping each deck separately and adding the results
 * lets every deck claim the whole budget, and three decks with 20 new cards
 * each read as "60 new" against a budget of 20.
 */
export function countDue(
  cards: Card[],
  performances: Map<string, ReviewedPerformance>,
  today: string = todayStr()
): { reviewDue: number; newCount: number; remainingBudget: number } {
  let reviewDue = 0;
  let newCount = 0;

  for (const card of cards) {
    if (card.status === "draft" || card.status === "suspended") continue;
    const perf = performances.get(stateKey(card));
    if (!perf) {
      newCount++;
    } else if (perf.dueDate <= today) {
      reviewDue++;
    }
  }

  return { reviewDue, newCount, remainingBudget: remainingBudget(today) };
}
