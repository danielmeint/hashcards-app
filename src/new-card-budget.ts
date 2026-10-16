import { Card, ReviewedPerformance } from "./types";
import { todayStr } from "./fsrs";
import { legacy, settings } from "./settings";
import { startedOn } from "./review-state";
import { markDirty } from "./collection-settings";
import { stateKey } from "./db";

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
 * The log is read asynchronously and the budget is asked synchronously (the
 * deck list, the drill), so the answer is kept here: refreshed whenever the
 * deck list loads, and kept current between refreshes by the drill, which
 * reports each first grade and each undo of one as it happens.
 */
let started: { date: string; keys: Set<string> } | null = null;

/** Re-read today's started cards from the log. */
export async function refreshIntroduced(today: string = todayStr()): Promise<void> {
  const keys = await startedOn(today);
  started = { date: today, keys };
  // The counter this replaced; its count would read as a reset here.
  legacy.introducedToday.remove();
}

export function getIntroducedToday(today: string = todayStr()): number {
  const count = started?.date === today ? started.keys.size : 0;
  const reset = settings.newCardsReset.get();
  return Math.max(0, count - (reset?.date === today ? reset.count : 0));
}

export function remainingBudget(today: string = todayStr()): number {
  return Math.max(0, getNewCardsPerDay() - getIntroducedToday(today));
}

/** The drill graded `key` for the first time (`started`), or undid that grade. */
export function recordIntroduced(today: string, key: string, first: boolean): void {
  if (started?.date !== today) started = { date: today, keys: new Set() };
  if (first) started.keys.add(key);
  else started.keys.delete(key);
}

/**
 * "Reset" in Settings: today's count starts again from zero on this device.
 * Local on purpose — it is a choice to do more today here, not a setting.
 */
export function resetIntroduced(today: string = todayStr()): void {
  const count = started?.date === today ? started.keys.size : 0;
  settings.newCardsReset.set({ date: today, count });
}

// --- Card classification ---

/** Select review-due and budget-capped new cards from a list. */
export function selectDueCards(
  cards: Card[],
  performances: Map<string, ReviewedPerformance>,
  today: string = todayStr()
): Card[] {
  const budget = remainingBudget(today);
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

  return [...reviewDue, ...newCards.slice(0, budget)];
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
