import { Card, ReviewedPerformance } from "./types";
import { todayStr } from "./fsrs";

const LS_KEY_PER_DAY = "new_cards_per_day";
const LS_KEY_INTRODUCED = "new_cards_introduced";
const DEFAULT_PER_DAY = 20;

// --- Settings ---

export function getNewCardsPerDay(): number {
  return parseInt(localStorage.getItem(LS_KEY_PER_DAY) || String(DEFAULT_PER_DAY), 10);
}

export function setNewCardsPerDay(n: number): void {
  localStorage.setItem(LS_KEY_PER_DAY, String(n));
}

// --- Today's budget ---

export function getIntroducedToday(today: string = todayStr()): number {
  const raw = localStorage.getItem(LS_KEY_INTRODUCED);
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { date: string; count: number };
  return parsed.date === today ? parsed.count : 0;
}

export function remainingBudget(today: string = todayStr()): number {
  return Math.max(0, getNewCardsPerDay() - getIntroducedToday(today));
}

export function recordIntroduced(today: string, count: number): void {
  const existing = getIntroducedToday(today);
  localStorage.setItem(
    LS_KEY_INTRODUCED,
    JSON.stringify({ date: today, count: existing + count })
  );
}

export function resetIntroduced(): void {
  localStorage.removeItem(LS_KEY_INTRODUCED);
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

/** Count review-due and budget-capped new cards per deck. */
export function countDue(
  cards: Card[],
  performances: Map<string, ReviewedPerformance>,
  today: string = todayStr()
): { reviewDue: number; newCount: number; remainingBudget: number } {
  const budget = remainingBudget(today);
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

  return {
    reviewDue,
    newCount: Math.min(newCount, budget),
    remainingBudget: budget,
  };
}
