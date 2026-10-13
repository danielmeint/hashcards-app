import { FSRSAlgorithm, default_w, generatorParameters } from "ts-fsrs";
import { Grade, Performance, ReviewedPerformance } from "./types";

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
 */

/** FSRS-6's published defaults: 21 weights, the last of them the curve's decay. */
export const PARAMETERS: readonly number[] = default_w;

const algorithm = new FSRSAlgorithm(
  generatorParameters({ w: [...PARAMETERS], enable_short_term: true })
);

/**
 * The forgetting curve's shape. FSRS-5 fixed it at 0.5; FSRS-6 learns it, and
 * the factor follows from it so that recall is exactly 90% at t = S.
 */
const DECAY = -PARAMETERS[20];
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

/**
 * The recall probability a card is scheduled to have decayed to when it comes
 * due. At 0.9 an interval equals the card's stability.
 */
export const DEFAULT_RETENTION = 0.9;
export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.97;

const MIN_INTERVAL = 0;
const MAX_INTERVAL = 256;

/** Probability of recall `t` days after a review that left stability `s`. */
export function retrievability(t: number, s: number): number {
  return Math.pow(1 + FACTOR * (t / s), DECAY);
}

/** Days until recall falls to `rd`, for stability `s`. */
export function interval(rd: number, s: number): number {
  return (s / FACTOR) * (Math.pow(rd, 1 / DECAY) - 1);
}

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

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fuzzInterval(days: number): number {
  if (days < 3) return days;
  const delta = Math.max(1, Math.round(days * 0.05));
  return days + Math.floor(Math.random() * (2 * delta + 1)) - delta;
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
};

export function updatePerformance(
  perf: Performance,
  grade: Grade,
  reviewedAt: string,
  { fuzz = false, retention = DEFAULT_RETENTION }: ScheduleOptions = {}
): ReviewedPerformance {
  // Days are local days, as `todayStr` — and so the due list — counts them.
  // These used to be the UTC date of the timestamp: reviewing after midnight
  // in Europe landed on the day before, and two reviews either side of local
  // midnight could count as the same day.
  const today = localDay(new Date(reviewedAt));
  const elapsed =
    perf.type === "new"
      ? 0
      : Math.max(0, daysBetween(localDay(new Date(perf.lastReviewedAt)), today));

  const { stability, difficulty } = algorithm.next_state(
    perf.type === "new"
      ? null
      : { stability: perf.stability, difficulty: perf.difficulty },
    elapsed,
    grade
  );

  // Retention moves the due date only. Stability and difficulty are what the
  // review taught us about the card, and they do not depend on when we chose
  // to ask again.
  const intervalRaw = interval(retention, stability);
  let intervalDays = Math.round(intervalRaw);
  if (fuzz) intervalDays = fuzzInterval(intervalDays);
  intervalDays = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, intervalDays));

  return {
    type: "reviewed",
    lastReviewedAt: reviewedAt,
    stability,
    difficulty,
    intervalRaw,
    intervalDays,
    dueDate: addDays(today, intervalDays),
    reviewCount: (perf.type === "new" ? 0 : perf.reviewCount) + 1,
  };
}
