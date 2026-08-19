import { Card, ReviewedPerformance } from "./types";
import { todayStr } from "./fsrs";
import { settings } from "./settings";

// --- Settings ---

export function getNewCardsPerDay(): number {
  return settings.newCardsPerDay.get();
}

export function setNewCardsPerDay(n: number): void {
  settings.newCardsPerDay.set(n);
}

// --- Today's budget ---

export function getIntroducedToday(today: string = todayStr()): number {
  const introduced = settings.introducedToday.get();
  return introduced?.date === today ? introduced.count : 0;
}

export function remainingBudget(today: string = todayStr()): number {
  return Math.max(0, getNewCardsPerDay() - getIntroducedToday(today));
}

export function recordIntroduced(today: string, count: number): void {
  const existing = getIntroducedToday(today);
  settings.introducedToday.set({ date: today, count: existing + count });
}

export function resetIntroduced(): void {
  settings.introducedToday.remove();
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
    const perf = performances.get(card.hash);
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
    const perf = performances.get(card.hash);
    if (!perf) {
      newCount++;
    } else if (perf.dueDate <= today) {
      reviewDue++;
    }
  }

  return { reviewDue, newCount, remainingBudget: remainingBudget(today) };
}
