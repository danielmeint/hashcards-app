import { Grade, Performance, ReviewedPerformance } from "./types";
import { DEFAULT_RETENTION, step } from "./core/schedule";

/**
 * Scheduling: FSRS-6, through the reference TypeScript implementation.
 *
 * This was a hand port of FSRS-5 that left out FSRS-5's same-day formula. A
 * card reviewed twice in one day then had a gap of 0 days, which means
 * predicted recall of 1.0, which zeroes the stability growth term — so a card
 * forgotten and re-learned the same day could not get anywhere. The fix was to
 * pretend the gap was a day.
 *
 * FSRS-6 models the same day directly, and is measurably better at it: on the
 * open SRS benchmark, with same-day reviews included, log loss falls from
 * 0.457 (FSRS-5) to 0.384. It is also the version the FSRS optimizer fits,
 * which is where per-collection tuning will come from.
 *
 * `ts-fsrs` is the memory model only — stability and difficulty after a
 * review. What this app does around it is its own: whole-day due dates in local
 * time, fuzz, the interval cap, and desired retention. FSRS-7 exists, but its
 * gains are mostly in fractional, within-day intervals, which a day-based
 * schedule cannot use, and it is still settling upstream.
 *
 * Stability means the same thing in both versions — the interval at which
 * recall has fallen to 90% — so states written under FSRS-5 carry over as they
 * are.
 *
 * The step itself lives in `src/core/schedule.ts`, shared with replay, so the
 * live path and the review log can never compute a card differently. This file
 * is the app's side of it: the device's clock and timezone.
 */

export {
  PARAMETERS,
  DEFAULT_RETENTION,
  MIN_RETENTION,
  MAX_RETENTION,
  retrievability,
  interval,
} from "./core/schedule";

/** The local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDay(at: Date = new Date()): string {
  return (
    at.getFullYear() +
    "-" +
    String(at.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(at.getDate()).padStart(2, "0")
  );
}

export function todayStr(): string {
  return localDay();
}

export function formatInterval(days: number): string {
  if (days < 1) return "<1d";
  if (days === 1) return "1d";
  if (days < 14) return `${days}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export type ScheduleOptions = {
  /** Vary the interval slightly, so cards learned together spread out. */
  fuzz?: boolean;
  /** Target recall at the due date; see `DEFAULT_RETENTION`. */
  retention?: number;
  /**
   * The card's key. With it, fuzz is seeded from the key and the review count,
   * exactly as replay seeds it; without it, fuzz is `Math.random`.
   */
  key?: string;
};

export function updatePerformance(
  perf: Performance,
  grade: Grade,
  reviewedAt: string,
  { fuzz = false, retention = DEFAULT_RETENTION, key }: ScheduleOptions = {}
): ReviewedPerformance {
  // Days are local days, as `todayStr` — and so the due list — counts them.
  // These used to be the UTC date of the timestamp: reviewing after midnight
  // in Europe landed on the day before, and two reviews either side of local
  // midnight could count as the same day.
  const today = localDay(new Date(reviewedAt));
  const prior =
    perf.type === "new"
      ? null
      : {
          stability: perf.stability,
          difficulty: perf.difficulty,
          lastDay: localDay(new Date(perf.lastReviewedAt)),
          reviewCount: perf.reviewCount,
        };

  const next = step(prior, grade, today, { fuzz, retention, key });

  return {
    type: "reviewed",
    lastReviewedAt: reviewedAt,
    stability: next.stability,
    difficulty: next.difficulty,
    intervalRaw: next.intervalRaw,
    intervalDays: next.intervalDays,
    dueDate: next.dueDate,
    reviewCount: next.reviewCount,
  };
}
