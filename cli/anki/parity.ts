import type { ReviewLogEvent } from "../../src/core/events";
import { replay } from "../../src/core/replay";
import type { ReplayOptions } from "../../src/core/replay";
import { PARAMETERS, addDays, dayAt, daysBetween, interval } from "../../src/core/schedule";
import type { ReferenceCard } from "./importer";

/**
 * M6's exit check: do the imported reviews, replayed by hashcards, put each
 * card due when Anki has it due?
 *
 * Not exactly, and not meant to. Hashcards replays with its own FSRS (the
 * published defaults until M7 fits parameters), its own fuzz, whole calendar
 * days rather than Anki's 4 a.m. rollover, and no learning steps: Anki keeps a
 * new card in learning for minutes after a first Good, where hashcards
 * schedules it straight away. The target is a day either way for 90% of
 * cards (PLAN-1.0 M6); this measures it, and keeps the cards that miss it so
 * the reason can be looked for.
 */

export type ParityRow = {
  key: string;
  state: ReferenceCard["state"];
  anki: string;
  hashcards: string;
  /** hashcards minus Anki, in days. */
  delta: number;
};

export type Parity = {
  /** Cards both sides have a due date for. */
  compared: number;
  withinOneDay: number;
  /** `withinOneDay / compared`; 1 when nothing was compared. */
  share: number;
  /** Delta in days → cards. */
  histogram: Map<number, number>;
  /** Cards left out, by why. */
  skipped: { new: number; suspended: number; noHistory: number };
  /** Every compared card, worst first. */
  rows: ParityRow[];
};

export function checkParity(
  events: readonly ReviewLogEvent[],
  reference: Record<string, ReferenceCard>,
  options: ReplayOptions
): Parity {
  const states = replay(events, options);
  const skipped = { new: 0, suspended: 0, noHistory: 0 };
  const rows: ParityRow[] = [];
  for (const [key, card] of Object.entries(reference)) {
    // A new card has no due date in Anki, and a suspended one is not
    // scheduled in either: neither says anything about the scheduler.
    if (card.state === "new" || card.due === null) {
      skipped.new++;
      continue;
    }
    if (card.suspended) {
      skipped.suspended++;
      continue;
    }
    const state = states.get(key);
    if (!state) {
      skipped.noHistory++;
      continue;
    }
    rows.push({
      key,
      state: card.state,
      anki: card.due,
      hashcards: state.dueDate,
      delta: daysBetween(card.due, state.dueDate),
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));
  const histogram = new Map<number, number>();
  for (const row of rows) histogram.set(row.delta, (histogram.get(row.delta) ?? 0) + 1);
  const withinOneDay = rows.filter((r) => Math.abs(r.delta) <= 1).length;
  return {
    compared: rows.length,
    withinOneDay,
    share: rows.length === 0 ? 1 : withinOneDay / rows.length,
    histogram: new Map([...histogram].sort(([a], [b]) => a - b)),
    skipped,
    rows,
  };
}

/**
 * The same comparison with fuzz taken out of both sides, to tell a scheduler
 * that disagrees with Anki from two that agree and then each add their own
 * noise. Anki fuzzes every interval from 3 days up (±15% at 3–7 days, ±10% to
 * 20, ±5% beyond), randomly, and stores only the result; hashcards fuzzes
 * too, seeded differently. So against Anki's real due dates a day's
 * tolerance is often spent before any model difference shows.
 *
 * Anki's unfuzzed due date is rebuilt from what `cards.data` records: its
 * stability, desired retention and decay, and the last review, counted on
 * Anki's day (local time less the rollover hour).
 */
export type ModelParity = {
  compared: number;
  /** Cards whose replayed stability is within 1% of Anki's. */
  sameStability: number;
  withinOneDay: number;
  share: number;
  histogram: Map<number, number>;
};

export function checkModel(
  events: readonly ReviewLogEvent[],
  reference: Record<string, ReferenceCard>,
  rolloverHour: number,
  tzAt: (ms: number) => number,
  options: Omit<ReplayOptions, "fuzz">
): ModelParity {
  const states = replay(events, { ...options, fuzz: false });
  const histogram = new Map<number, number>();
  let compared = 0;
  let sameStability = 0;
  let withinOneDay = 0;
  for (const [key, card] of Object.entries(reference)) {
    const fsrs = card.fsrs;
    const state = states.get(key);
    if (card.state === "new" || card.suspended || !fsrs?.lastReview || !state) continue;
    compared++;
    if (Math.abs(state.stability / fsrs.stability - 1) <= 0.01) sameStability++;
    const params = [...PARAMETERS];
    if (fsrs.decay !== null) params[20] = fsrs.decay;
    const days = Math.max(1, Math.round(interval(fsrs.desiredRetention ?? 0.9, fsrs.stability, params)));
    const ms = Date.parse(fsrs.lastReview) - rolloverHour * 3_600_000;
    const ankiDue = addDays(dayAt(new Date(ms).toISOString(), tzAt(ms)), days);
    const delta = daysBetween(ankiDue, state.dueDate);
    histogram.set(delta, (histogram.get(delta) ?? 0) + 1);
    if (Math.abs(delta) <= 1) withinOneDay++;
  }
  return {
    compared,
    sameStability,
    withinOneDay,
    share: compared === 0 ? 1 : withinOneDay / compared,
    histogram: new Map([...histogram].sort(([a], [b]) => a - b)),
  };
}
