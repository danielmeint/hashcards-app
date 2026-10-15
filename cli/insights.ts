import type { ReviewLogEvent } from "../src/core/events";
import { fallbackTz } from "../src/core/events";
import type { CardState } from "../src/core/replay";
import { PARAMETERS, addDays, dayAt, daysBetween, retrievability } from "../src/core/schedule";
import { LEECH_THRESHOLD, RECOVERED_STREAK } from "../src/leeches";
import type { ParsedCard } from "../src/types";

/**
 * Numbers computed from the event log, shared by `due`, `stats` and
 * `leeches`. All pure: events, states and a day in, numbers out.
 */

/** The local day an event happened on, in the timezone it recorded. */
export function eventDay(e: ReviewLogEvent): string {
  return dayAt(e.at, e.tz ?? fallbackTz(e.at));
}

/** Each card's events, in time order. */
export function eventsByCard(events: readonly ReviewLogEvent[]): Map<string, ReviewLogEvent[]> {
  const by = new Map<string, ReviewLogEvent[]>();
  for (const e of events) by.set(e.card, [...(by.get(e.card) ?? []), e]);
  for (const list of by.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return by;
}

/**
 * New cards already started on `day`: those whose very first event is a
 * review on that day. This is what the day's new-card budget has been spent
 * on, wherever the reviews were done — the app's per-device counter cannot
 * know about another phone's, the log can.
 */
export function introducedOn(byCard: Map<string, ReviewLogEvent[]>, day: string): number {
  let n = 0;
  for (const list of byCard.values()) {
    if (list[0].kind === "review" && eventDay(list[0]) === day) n++;
  }
  return n;
}

export type Retention = { reviews: number; passed: number; rate: number | null };

/**
 * True retention: of the reviews that tested a card already learned (not a
 * card's first ever review), the share not graded Forgot. Since `since`, if
 * given.
 */
export function trueRetention(byCard: Map<string, ReviewLogEvent[]>, since?: string): Retention {
  let reviews = 0;
  let passed = 0;
  for (const list of byCard.values()) {
    list.forEach((e, i) => {
      if (e.kind !== "review" || i === 0) return;
      if (since && eventDay(e) < since) return;
      reviews++;
      if (e.grade > 1) passed++;
    });
  }
  return { reviews, passed, rate: reviews === 0 ? null : passed / reviews };
}

/** Mean predicted recall of `cards` on `day`, from their stability. */
export function predictedRetention(
  cards: readonly ParsedCard[],
  states: Map<string, CardState>,
  day: string
): number | null {
  let sum = 0;
  let n = 0;
  for (const card of cards) {
    const s = states.get(card.key);
    if (!s) continue;
    sum += retrievability(Math.max(0, daysBetween(s.lastDay, day)), s.stability, PARAMETERS);
    n++;
  }
  return n === 0 ? null : sum / n;
}

/** Reviews due on each of `days` days from `today`; overdue ones count today. */
export function forecast(
  cards: readonly ParsedCard[],
  states: Map<string, CardState>,
  today: string,
  days: number
): { date: string; due: number }[] {
  const out = Array.from({ length: days }, (_, i) => ({ date: addDays(today, i), due: 0 }));
  for (const card of cards) {
    const s = states.get(card.key);
    if (!s) continue;
    const i = Math.max(0, daysBetween(today, s.dueDate));
    if (i < days) out[i].due++;
  }
  return out;
}

/** Reviews graded on each of the `days` days up to and including `today`. */
export function reviewsPerDay(
  events: readonly ReviewLogEvent[],
  today: string,
  days: number
): { date: string; reviews: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "review") continue;
    const day = eventDay(e);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i - days + 1);
    return { date, reviews: counts.get(date) ?? 0 };
  });
}

/** Days in a row, ending today or yesterday, with at least one review. */
export function streak(events: readonly ReviewLogEvent[], today: string): number {
  const days = new Set(events.filter((e) => e.kind === "review").map(eventDay));
  let day = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

export type LeechStats = {
  key: string;
  lapses: number;
  reviews: number;
  lastLapseAt: string;
  /** Passes since the last lapse. */
  streak: number;
  recovering: boolean;
};

/**
 * Keys with at least `threshold` lapses (reviews graded Forgot), from the
 * whole log — the same rule and order as the app's leech list
 * (`src/leeches.ts`), which until M3 only sees one device's reviews.
 */
export function leeches(
  byCard: Map<string, ReviewLogEvent[]>,
  threshold = LEECH_THRESHOLD
): LeechStats[] {
  const out: LeechStats[] = [];
  for (const [key, list] of byCard) {
    const reviews = list.filter((e) => e.kind === "review");
    const lapses = reviews.flatMap((e, i) => (e.grade === 1 ? [i] : []));
    if (lapses.length < threshold || lapses.length === 0) continue;
    const last = lapses[lapses.length - 1];
    const streakAfter = reviews.length - last - 1;
    out.push({
      key,
      lapses: lapses.length,
      reviews: reviews.length,
      lastLapseAt: reviews[last].at,
      streak: streakAfter,
      recovering: streakAfter >= RECOVERED_STREAK,
    });
  }
  out.sort(
    (a, b) =>
      Number(a.recovering) - Number(b.recovering) ||
      b.lapses - a.lapses ||
      b.lapses / b.reviews - a.lapses / a.reviews ||
      a.key.localeCompare(b.key)
  );
  return out;
}

/** Anki's line: an interval of three weeks or more is a mature card. */
export const MATURE_DAYS = 21;
