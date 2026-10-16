import { Card, Review } from "./types";
import { stateKey, keyInLog } from "./card-key";
import { ReviewEvent } from "./core/events";
import { CardState, ReplayOptions, applyEvent } from "./core/replay";
import { GradeValue, addDays, seededUnit, utcOffsetMinutes } from "./core/schedule";

/**
 * A few weeks of made-up reviews for the demo, so Today has cards due and
 * Statistics has a heatmap, a forecast and a leech — none of which a brand-new
 * collection can show.
 *
 * Made up, but by the real scheduler: each card is reviewed on the days its
 * own schedule says it was due, and every grade goes through `applyEvent`, the
 * step replay uses. So the history is one the app could have produced, and
 * replaying it gives exactly the states the drill then works from. It is
 * deterministic (seeded per card), so every visitor sees the same demo and a
 * test can pin it down; only "today" moves.
 */

export type HistoryOptions = {
  /** Local day the history leads up to, `YYYY-MM-DD`. Nothing is dated on or after it. */
  today: string;
  /** The collection whose log the reviews belong to. */
  log: string;
  replay: ReplayOptions;
  /** Cards to leave unseen, so the demo still has new cards to introduce. */
  fresh?: (card: Card) => boolean;
  /** Cards that keep being forgotten, so Statistics has a leech to show. */
  struggling?: (card: Card) => boolean;
};

/** How far back a card's first review may be. */
const OLDEST_START = 42;
const NEWEST_START = 4;
/** Share of the remaining cards that are left new as well. */
const UNSEEN = 0.15;
/**
 * The last few days before today went unreviewed, by up to this many days per
 * card. Without a gap every card would have been reviewed on time and almost
 * nothing would be due; with one, what fell due in it is waiting today.
 */
const MAX_GAP = 5;

/** A grade drawn per card and review, mostly Good, as real reviewing goes. */
function drawGrade(key: string, n: number): GradeValue {
  const u = seededUnit(`${key}#grade${n}`);
  const forgot = n === 0 ? 0.12 : 0.07;
  if (u < forgot) return 1;
  if (u < forgot + 0.12) return 2;
  if (u < 0.9) return 3;
  return 4;
}

/** Forgot, Hard, Forgot, Hard…: it never sticks, which is what a leech is. */
function strugglingGrade(n: number): GradeValue {
  return n % 2 === 0 ? 1 : 2;
}

/** An instant on local day `day`, at a time of day seeded per review. */
function localInstant(day: string, key: string, n: number): Date {
  const hour = 7 + Math.floor(seededUnit(`${key}#hour${n}`) * 14);
  const minute = Math.floor(seededUnit(`${key}#minute${n}`) * 60);
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute);
}

export function demoHistory(cards: Card[], options: HistoryOptions): Review[] {
  const reviews: Review[] = [];
  for (const card of cards) {
    if (card.status !== "active" || options.fresh?.(card)) continue;
    const key = stateKey(card);
    if (seededUnit(`${key}#unseen`) < UNSEEN && !options.struggling?.(card)) continue;
    reviews.push(...cardHistory(card, options));
  }
  return reviews.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
}

function cardHistory(card: Card, options: HistoryOptions): Review[] {
  const key = stateKey(card);
  const inLog = keyInLog(options.log, key);
  const struggling = options.struggling?.(card) ?? false;
  // A leech needs lapses to show for: it starts as early as any card does.
  const start = struggling
    ? OLDEST_START
    : NEWEST_START + Math.floor(seededUnit(`${key}#start`) * (OLDEST_START - NEWEST_START));

  const out: Review[] = [];
  let state: CardState | undefined;
  const stop = addDays(options.today, -Math.floor(seededUnit(`${key}#gap`) * MAX_GAP));
  let day = addDays(options.today, -start);
  // Bounded, though a schedule only ever moves forward: a history is a few
  // reviews per card, never a loop.
  for (let n = 0; day < stop && n < 40; n++) {
    const at = localInstant(day, key, n);
    const grade = struggling ? strugglingGrade(n) : drawGrade(key, n);
    const event: ReviewEvent = {
      v: 2,
      kind: "review",
      card: inLog,
      at: at.toISOString(),
      tz: utcOffsetMinutes(at),
      grade,
      ms: 2500 + Math.floor(seededUnit(`${key}#ms${n}`) * 9000),
    };
    state = applyEvent(state, event, options.replay);
    out.push({
      key,
      log: options.log,
      tz: event.tz,
      cardHash: card.hash,
      reviewedAt: event.at,
      grade,
      stability: state.stability,
      difficulty: state.difficulty,
      intervalRaw: state.intervalRaw,
      intervalDays: state.intervalDays,
      dueDate: state.dueDate,
      durationMs: event.ms,
    });
    // A lapse can be due again the same day; in the demo it waits for the next.
    day = state.dueDate > day ? state.dueDate : addDays(day, 1);
  }
  return out;
}
