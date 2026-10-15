// The live path counts days in the machine's zone, so pin one with summer
// time. Replay must agree with it from the offsets recorded in the events.
process.env.TZ = "Europe/Berlin";

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { updatePerformance } from "../fsrs";
import { Grade, Performance, ReviewedPerformance } from "../types";
import { BaselineEvent, ReviewEvent, ReviewLogEvent, parseFile } from "./events";
import { CardState, ReplayOptions, compareEvents, replay, replayAll, replayMore } from "./replay";
import { PARAMETERS, addDays } from "./schedule";

/**
 * Replay is only the source of truth if it agrees with what the app computed
 * while you were reviewing. These tests drive the live `updatePerformance`
 * path and replay the log it would have written, and check that every card
 * lands in exactly the same state — stability, difficulty, due date, all of
 * it, not "close".
 */

/** What replay and the live path both know about a card. */
function perfOf(state: CardState): ReviewedPerformance {
  const { lastDay: _day, lastGrade: _grade, ...perf } = state;
  return perf;
}

/** A small deterministic PRNG, so a failing session can be re-run. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Recorded = {
  events: ReviewEvent[];
  /** The live state after each event, in the order they happened. */
  after: ReviewedPerformance[];
  final: Map<string, ReviewedPerformance>;
};

/**
 * Eight months of drills, the way the app runs them: once or twice a day at
 * varying local times — some just before and just after midnight — every due
 * card plus a few new ones, grades skewed towards Good, and a forgotten card
 * brought round again later in the same drill. The span crosses both summer
 * time changes.
 */
function simulate(options: { fuzz: boolean; retention: number; seed: number }): Recorded {
  const random = rng(options.seed);
  const cards = Array.from({ length: 30 }, (_, i) => `deck-${i}:${i % 3 === 0 ? "r" : "1"}`);
  const perf = new Map<string, Performance>(cards.map((c) => [c, { type: "new" }]));
  const events: ReviewEvent[] = [];
  const after: ReviewedPerformance[] = [];

  const pickGrade = (): Grade => {
    const r = random();
    return r < 0.15 ? Grade.Forgot : r < 0.3 ? Grade.Hard : r < 0.85 ? Grade.Good : Grade.Easy;
  };

  const grade = (card: string, at: Date, g: Grade) => {
    const reviewedAt = at.toISOString();
    const next = updatePerformance(perf.get(card)!, g, reviewedAt, {
      fuzz: options.fuzz,
      retention: options.retention,
      key: card,
    });
    perf.set(card, next);
    // What the app will write: the offset in effect at the moment of review.
    events.push({ v: 2, kind: "review", card, at: reviewedAt, tz: -at.getTimezoneOffset(), grade: g });
    after.push(next);
    return next;
  };

  const localTimes = [
    [7, 5],
    [12, 40],
    [18, 15],
    [23, 50],
    [0, 20], // after midnight: still yesterday at UTC
  ];
  // The clock only moves forward: a drill that runs late can delay the next.
  let t = 0;
  for (let day = 0; day < 240; day++) {
    const sessions = random() < 0.3 ? 2 : 1;
    const times = Array.from({ length: sessions }, () => localTimes[Math.floor(random() * localTimes.length)]);
    times.sort(([h1, m1], [h2, m2]) => h1 * 60 + m1 - (h2 * 60 + m2));
    for (const [h, m] of times) {
      t = Math.max(t, new Date(2026, 8, 1 + day, h, m).getTime());
      const today = localDayOf(new Date(t));
      let newBudget = 3;
      const queue = cards.filter((c) => {
        const p = perf.get(c)!;
        if (p.type === "new") return newBudget-- > 0;
        return p.dueDate <= today;
      });
      while (queue.length) {
        const card = queue.shift()!;
        t += 5_000 + Math.floor(random() * 40_000);
        const next = grade(card, new Date(t), pickGrade());
        // A lapse due today comes round again later in the drill.
        if (next.dueDate <= localDayOf(new Date(t))) queue.push(card);
      }
    }
  }
  const final = new Map<string, ReviewedPerformance>();
  for (const [card, p] of perf) if (p.type === "reviewed") final.set(card, p);
  return { events, after, final };
}

function localDayOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("replay agrees with the live path", () => {
  for (const fuzz of [false, true]) {
    describe(fuzz ? "with fuzz, seeded the same way" : "without fuzz", () => {
      const options: ReplayOptions = { fuzz, retention: 0.9 };
      const recorded = simulate({ fuzz, retention: 0.9, seed: fuzz ? 2 : 1 });

      it("covers what it claims to", () => {
        const { events } = recorded;
        expect(events.length).toBeGreaterThan(300);
        const offsets = new Set(events.map((e) => e.tz));
        expect(offsets).toEqual(new Set([60, 120]));
        // Same-day relearning, and reviews after local midnight that are
        // still the previous day at UTC.
        expect(events.some((e, i) => i > 0 && e.card === events[i - 1].card)).toBe(true);
        expect(events.some((e) => new Date(e.at).getUTCDate() !== new Date(e.at).getDate())).toBe(true);
      });

      it("in every card's final state", () => {
        const replayed = replay(recorded.events, options);
        expect(replayed.size).toBe(recorded.final.size);
        for (const [card, live] of recorded.final) {
          expect(perfOf(replayed.get(card)!), card).toEqual(live);
        }
      });

      it("after every single review, replayed incrementally", () => {
        let state = replayAll([], options);
        recorded.events.forEach((event, i) => {
          const next = replayMore(state, [event], () => recorded.events.slice(0, i + 1), options);
          expect(next.replayedAll).toBe(false);
          state = next;
          expect(perfOf(state.cards.get(event.card)!)).toEqual(recorded.after[i]);
        });
      });

      it("whichever zone the replaying device is in", () => {
        const saved = process.env.TZ;
        try {
          process.env.TZ = "America/Los_Angeles";
          const replayed = replay(recorded.events, options);
          for (const [card, live] of recorded.final) expect(perfOf(replayed.get(card)!)).toEqual(live);
        } finally {
          process.env.TZ = saved;
        }
      });
    });
  }

  it("and fuzz actually moved some due dates", () => {
    const on = replay(simulate({ fuzz: true, retention: 0.9, seed: 2 }).events, { fuzz: true, retention: 0.9 });
    const off = replay(simulate({ fuzz: true, retention: 0.9, seed: 2 }).events, { fuzz: false, retention: 0.9 });
    const moved = [...on].filter(([card, s]) => off.get(card)!.intervalDays !== s.intervalDays);
    expect(moved.length).toBeGreaterThan(0);
  });
});

/**
 * The real v1 log: the first days of reviews from Daniel's collection, two
 * devices, copied from `my-hashcards/hashcards-reviews` along with the state
 * file's entries for the same cards. Card text is not in it, only hashes.
 *
 * Each v1 line recorded the stability and difficulty the live path computed
 * at the time, and the state file holds where each card ended up. Replay has
 * to reproduce both from the grades and times alone.
 */
describe("the real v1 log", () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const files = ["v1-2026-10.3e2bd77f.jsonl", "v1-2026-10.5a1b5635.jsonl"].map(fixture);
  const state: Record<string, ReviewedPerformance> = JSON.parse(fixture("v1-state.json")).cards;

  type V1Line = { card: string; at: string; grade: Grade; s: number; d: number };
  const lines: V1Line[] = files.flatMap((f) => f.trim().split("\n").map((l) => JSON.parse(l)));
  const parsed = files.map((f) => parseFile(f));
  const events = parsed.flatMap((p) => p.events) as ReviewEvent[];
  const recordedAfter = new Map(lines.map((l) => [`${l.card}@${l.at}`, l]));

  /**
   * Cards whose first logged review was not their first review: the log
   * began on 13 October, and they had history before it. Their first line
   * carries the state after that review, which is what a baseline is; M4
   * will write one from the state file instead.
   */
  const newStability = (g: Grade) => PARAMETERS[g - 1];
  const firstLine = new Map<string, V1Line>();
  for (const l of [...lines].sort((a, b) => a.at.localeCompare(b.at))) if (!firstLine.has(l.card)) firstLine.set(l.card, l);
  const veterans = [...firstLine.values()].filter((l) => Math.abs(l.s - newStability(l.grade)) > 1e-6);
  const baselines: BaselineEvent[] = veterans.map((l) => ({
    v: 2,
    kind: "baseline",
    card: l.card,
    at: l.at,
    s: l.s,
    d: l.d,
    reps: state[l.card].reviewCount - lines.filter((o) => o.card === l.card && o.at > l.at).length,
    grade: l.grade,
    src: "v1",
  }));
  const all: ReviewLogEvent[] = [...events, ...baselines];

  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

  it("parses without a single error", () => {
    expect(parsed.flatMap((p) => p.errors)).toEqual([]);
    expect(events).toHaveLength(60);
    expect(new Set(events.map((e) => e.card)).size).toBe(53);
    expect(veterans.map((l) => l.card.slice(0, 8)).sort()).toEqual(["0d19b84b", "b1f20fb8"]);
  });

  it("reproduces the stability and difficulty logged after every review", () => {
    const sorted = [...all].sort(compareEvents);
    let state = replayAll([], { fuzz: false, retention: 0.9 });
    for (const event of sorted) {
      state = replayMore(state, [event], () => all, { fuzz: false, retention: 0.9 });
      // A review its own baseline stands for is checked once the baseline,
      // which sorts right after it, has been applied.
      if (event.kind === "review" && baselines.some((b) => b.card === event.card && b.at === event.at)) continue;
      const logged = recordedAfter.get(`${event.card}@${event.at}`)!;
      const replayed = state.cards.get(event.card)!;
      expect(close(replayed.stability, logged.s), `${event.card} s at ${event.at}`).toBe(true);
      expect(close(replayed.difficulty, logged.d), `${event.card} d at ${event.at}`).toBe(true);
    }
  });

  it("ends every card where the state file has it", () => {
    const replayed = replay(all, { fuzz: false, retention: 0.9 });
    expect(replayed.size).toBe(Object.keys(state).length);
    for (const [card, v1] of Object.entries(state)) {
      const s = replayed.get(card)!;
      expect(s.lastReviewedAt).toBe(v1.lastReviewedAt);
      expect(s.reviewCount).toBe(v1.reviewCount);
      expect(close(s.stability, v1.stability)).toBe(true);
      expect(close(s.difficulty, v1.difficulty)).toBe(true);
      expect(close(s.intervalRaw, v1.intervalRaw)).toBe(true);
      // The live app drew fuzz from Math.random, so its interval is any one
      // within the fuzz range of replay's unfuzzed one — but counted from the
      // same local day, which is what the fallback zone has to get right.
      const delta = s.intervalDays < 3 ? 0 : Math.max(1, Math.round(s.intervalDays * 0.05));
      expect(Math.abs(v1.intervalDays - s.intervalDays), card).toBeLessThanOrEqual(delta);
      expect(addDays(s.lastDay, v1.intervalDays), card).toBe(v1.dueDate);
    }
  });

  it("gives what the live path gives, card by card", () => {
    // Cards that started in the log; the veterans' earlier history is not in it.
    const veteranCards = new Set(veterans.map((l) => l.card));
    const perf = new Map<string, Performance>();
    for (const e of [...events].sort(compareEvents)) {
      if (veteranCards.has(e.card)) continue;
      perf.set(e.card, updatePerformance(perf.get(e.card) ?? { type: "new" }, e.grade, e.at, { key: e.card }));
    }
    expect(perf.size).toBe(51);
    const replayed = replay(all, { fuzz: false, retention: 0.9 });
    for (const [card, p] of perf) expect(perfOf(replayed.get(card)!), card).toEqual(p);
  });
});
