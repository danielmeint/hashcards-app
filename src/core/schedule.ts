import { FSRSAlgorithm, default_w, generatorParameters } from "ts-fsrs";

/**
 * The scheduling step, with no clock, no timezone and no randomness of its own.
 *
 * Both ways of arriving at a card's state go through here: the live path
 * (`src/fsrs.ts`, a grade as it happens) and replay (`src/core/replay.ts`, the
 * review log read back). If they each had their own copy, they would drift,
 * and a drift here moves due dates the moment the log becomes the source of
 * truth. So days come in as `YYYY-MM-DD` strings the caller has already put in
 * the right timezone, and fuzz is seeded from the card and its review count
 * rather than drawn from `Math.random`.
 *
 * The memory model is FSRS-6 through `ts-fsrs` — see `src/fsrs.ts` for why that
 * version and why the reference implementation. What happens around it is this
 * app's own: whole local days, fuzz, desired retention, and the rule that a
 * pass is never due the same day.
 */

/** A grade, 1–4 as FSRS and `src/types.ts`'s `Grade` number them. */
export type GradeValue = 1 | 2 | 3 | 4;

/** Forgot. The only grade that may leave a card due the day it was reviewed. */
export const FORGOT: GradeValue = 1;

/** FSRS-6's published defaults: 21 weights, the last of them the curve's decay. */
export const PARAMETERS: readonly number[] = default_w;

/**
 * The recall probability a card is scheduled to have decayed to when it comes
 * due. At 0.9 an interval equals the card's stability.
 */
export const DEFAULT_RETENTION = 0.9;
/**
 * Narrower than Anki's 70–97%. FSRS-6's curve is flat, so retention bites
 * hard: a new card graded Good is 2 days out at 90% but ~3 weeks at 70%, the
 * "massive interval jumps at low desired retention" the FSRS benchmark warns
 * of. At the top, Anki's own manual calls workload above 95% overwhelming.
 */
export const MIN_RETENTION = 0.8;
export const MAX_RETENTION = 0.95;

/**
 * One FSRS instance per parameter set. Fitted parameters (M7) arrive as a new
 * array each time they are read, so key on the values, not the array.
 */
const algorithms = new Map<string, FSRSAlgorithm>();
function algorithmFor(params: readonly number[]): FSRSAlgorithm {
  const id = params.join(",");
  let algorithm = algorithms.get(id);
  if (!algorithm) {
    algorithm = new FSRSAlgorithm(
      generatorParameters({ w: [...params], enable_short_term: true })
    );
    algorithms.set(id, algorithm);
  }
  return algorithm;
}

/**
 * The forgetting curve's shape. FSRS-5 fixed it at 0.5; FSRS-6 learns it, and
 * the factor follows from it so that recall is exactly 90% at t = S.
 */
function curve(params: readonly number[]): { decay: number; factor: number } {
  const decay = -params[20];
  return { decay, factor: Math.pow(0.9, 1 / decay) - 1 };
}

/** Probability of recall `t` days after a review that left stability `s`. */
export function retrievability(
  t: number,
  s: number,
  params: readonly number[] = PARAMETERS
): number {
  const { decay, factor } = curve(params);
  return Math.pow(1 + factor * (t / s), decay);
}

/** Days until recall falls to `rd`, for stability `s`. */
export function interval(
  rd: number,
  s: number,
  params: readonly number[] = PARAMETERS
): number {
  const { decay, factor } = curve(params);
  return (s / factor) * (Math.pow(rd, 1 / decay) - 1);
}

// --- Days -------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * This device's UTC offset in minutes at `at`, east positive: what a review
 * records as `tz`. `|| 0` because in UTC the negation is -0, which JSON writes
 * as 0, so an event would not equal its own round trip.
 */
export function utcOffsetMinutes(at: string | Date): number {
  return -new Date(at).getTimezoneOffset() || 0;
}

/**
 * The calendar day of an instant at a UTC offset of `tz` minutes (east
 * positive, so Berlin in summer is +120), as `YYYY-MM-DD`.
 *
 * This is what makes replay independent of the device doing it: the offset is
 * the one recorded with the review, not whatever the replaying machine's clock
 * is set to.
 */
export function dayAt(at: string | Date, tz: number): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Date(ms + tz * 60_000).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(a + "T00:00:00Z");
  const db = Date.parse(b + "T00:00:00Z");
  return Math.round((db - da) / DAY_MS);
}

export function addDays(day: string, days: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- Fuzz -------------------------------------------------------------------

/**
 * A number in [0, 1) that depends only on `seed`: FNV-1a over the string's
 * UTF-16 code units, then murmur3's finaliser so that seeds differing in one
 * trailing digit (`…#3`, `…#4`) land far apart. Not cryptographic, and does
 * not need to be — it only has to be the same on every device.
 */
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

/**
 * The fuzz seed for a card's `reviewCount`-th review (1-based, counting the
 * reps a baseline carries). The live path and replay both know the key and the
 * count, and nothing else about a review is guaranteed to be identical between
 * them — not even the timestamp's formatting.
 */
export function fuzzSeed(key: string, reviewCount: number): string {
  return `${key}#${reviewCount}`;
}

/**
 * ±5% (at least a day either way), so cards learned together spread out. Short
 * intervals are left alone: a day either side of two is a 50% change.
 */
export function fuzzInterval(days: number, unit: number): number {
  if (days < 3) return days;
  const delta = Math.max(1, Math.round(days * 0.05));
  return days + Math.floor(unit * (2 * delta + 1)) - delta;
}

// --- The step ---------------------------------------------------------------

export type MemoryState = { stability: number; difficulty: number };

/** What the scheduler needs to know about a card before a review. */
export type PriorState = MemoryState & {
  /** The local day of the review that left it in this state. */
  lastDay: string;
  reviewCount: number;
};

export type StepOptions = {
  retention?: number;
  /** Vary the interval slightly, so cards learned together spread out. */
  fuzz?: boolean;
  /**
   * The card's key, to seed fuzz. Without one, fuzz falls back to
   * `Math.random` — the live path's behaviour before replay existed, and still
   * what a caller that cannot name the card gets.
   */
  key?: string;
  params?: readonly number[];
};

export type Scheduled = {
  intervalRaw: number;
  intervalDays: number;
  dueDate: string;
};

/**
 * When a card reviewed on `day` with `grade` comes due, given what it now has
 * in stability. Split from the memory update because replay calls it on its
 * own: the due date is always recomputed at the *current* retention.
 *
 * `grade` null means unknown (a baseline that did not record one); it is
 * treated as a pass.
 */
export function schedule(
  stability: number,
  grade: GradeValue | null,
  day: string,
  reviewCount: number,
  { retention = DEFAULT_RETENTION, fuzz = false, key, params = PARAMETERS }: StepOptions = {}
): Scheduled {
  // Retention moves the due date only. Stability and difficulty are what the
  // review taught us about the card, and they do not depend on when we chose
  // to ask again.
  //
  // No cap beyond the model's own (stability tops out at 100 years). There
  // was a 256-day one, which only ever meant a card known cold came back every
  // eight months whether or not it needed to.
  //
  // A pass is never due again the same day. Only a lapse may be: that is what
  // lets a card you failed come back in a later drill today. This was 0 for
  // everything, and a weak card that was passed the same day kept rounding to
  // 0 — under FSRS-5 it could not escape at all (the April "stuck card"), and
  // under FSRS-6 a forgotten card still took seven same-day passes to leave.
  // Anki draws the same line: minutes are for learning steps, which here is
  // the drill bringing a card round again, and a graduated card is a day out.
  const intervalRaw = interval(retention, stability, params);
  let intervalDays = Math.round(intervalRaw);
  if (fuzz) {
    const unit =
      key === undefined ? Math.random() : seededUnit(fuzzSeed(key, reviewCount));
    intervalDays = fuzzInterval(intervalDays, unit);
  }
  intervalDays = Math.max(grade === FORGOT ? 0 : 1, intervalDays);
  return { intervalRaw, intervalDays, dueDate: addDays(day, intervalDays) };
}

export type Stepped = MemoryState & Scheduled & { reviewCount: number };

/**
 * One review: `prior` (null for a new card) graded `grade` on local day
 * `today`. Pure apart from the keyless-fuzz fallback above.
 */
export function step(
  prior: PriorState | null,
  grade: GradeValue,
  today: string,
  options: StepOptions = {}
): Stepped {
  const params = options.params ?? PARAMETERS;
  const elapsed = prior ? Math.max(0, daysBetween(prior.lastDay, today)) : 0;
  const { stability, difficulty } = algorithmFor(params).next_state(
    prior ? { stability: prior.stability, difficulty: prior.difficulty } : null,
    elapsed,
    grade
  );
  const reviewCount = (prior?.reviewCount ?? 0) + 1;
  return {
    stability,
    difficulty,
    reviewCount,
    ...schedule(stability, grade, today, reviewCount, options),
  };
}
