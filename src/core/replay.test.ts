import { describe, expect, it } from "vitest";
import { BaselineEvent, ReviewEvent, ReviewLogEvent } from "./events";
import { CardState, ReplayOptions, Replayed, compareEvents, replay, replayAll, replayMore } from "./replay";
import { GradeValue, interval, schedule, step } from "./schedule";
import { ReviewedPerformance } from "../types";

const OFF: ReplayOptions = { fuzz: false, retention: 0.9 };

function rev(card: string, at: string, grade: GradeValue, tz = 120, extra: Partial<ReviewEvent> = {}): ReviewEvent {
  return { v: 2, kind: "review", card, at, tz, grade, ...extra };
}

function base(card: string, at: string, s: number, d: number, reps: number, extra: Partial<BaselineEvent> = {}): BaselineEvent {
  return { v: 2, kind: "baseline", card, at, tz: 120, s, d, reps, ...extra };
}

/** A small deterministic PRNG, for shuffles and simulated sessions. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A handful of cards over a few weeks, two of them reviewed on the same day. */
const LOG: ReviewLogEvent[] = [
  rev("a", "2026-10-01T07:00:00Z", 3),
  rev("b", "2026-10-01T07:01:00Z", 1),
  rev("b", "2026-10-01T07:09:00Z", 3),
  rev("c", "2026-10-01T21:59:00Z", 4),
  rev("a", "2026-10-03T19:00:00Z", 3),
  rev("b", "2026-10-02T08:00:00Z", 2),
  base("d", "2026-09-20T10:00:00Z", 30, 4.5, 6),
  rev("d", "2026-10-20T10:00:00Z", 3),
  rev("a", "2026-10-09T22:30:00Z", 1),
  rev("a", "2026-10-09T22:40:00Z", 3),
  rev("c", "2026-10-09T06:00:00Z", 3),
  rev("a", "2026-10-11T06:00:00Z", 3),
];

describe("replay", () => {
  it("applies a card's reviews in order through the shared step", () => {
    const a = replay(LOG, OFF).get("a")!;
    const steps: [GradeValue, string][] = [
      [3, "2026-10-01"],
      [3, "2026-10-03"],
      [1, "2026-10-10"], // 22:30Z is past midnight in Berlin
      [3, "2026-10-10"],
      [3, "2026-10-11"],
    ];
    let prior: Parameters<typeof step>[0] = null;
    for (const [grade, day] of steps) {
      const next = step(prior, grade, day);
      prior = { ...next, lastDay: day };
    }
    expect(a).toMatchObject({
      stability: prior!.stability,
      difficulty: prior!.difficulty,
      reviewCount: 5,
      lastReviewedAt: "2026-10-11T06:00:00Z",
      lastDay: "2026-10-11",
      lastGrade: 3,
    });
  });

  it("is a ReviewedPerformance the app can use as one", () => {
    const state: CardState = replay(LOG, OFF).get("a")!;
    const perf: ReviewedPerformance = state;
    expect(perf.type).toBe("reviewed");
  });

  it("gives the same states whatever order the events arrive in", () => {
    const expected = replay(LOG, OFF);
    for (let seed = 1; seed <= 20; seed++) {
      expect(replay(shuffled(LOG, seed), OFF)).toEqual(expected);
    }
  });

  it("does not touch its input", () => {
    const events = [...LOG];
    replay(events, OFF);
    expect(events).toEqual(LOG);
  });

  it("applies an event that appears twice once", () => {
    const once = replay(LOG, OFF);
    const twice = replay([...LOG, ...LOG.slice(0, 4)], OFF);
    expect(twice).toEqual(once);
  });

  it("settles two devices grading one card in the same millisecond the same way everywhere", () => {
    const at = "2026-10-05T10:00:00.000Z";
    const events = [rev("x", "2026-10-01T10:00:00Z", 3), rev("x", at, 1, 120, { ms: 10 }), rev("x", at, 4, 120, { ms: 20 })];
    const forward = replay(events, OFF).get("x")!;
    const backward = replay([...events].reverse(), OFF).get("x")!;
    expect(backward).toEqual(forward);
    expect(forward.reviewCount).toBe(3);
  });

  it("orders by instant, not by how the instant is written", () => {
    // 09:00+02:00 is 07:00Z: before 08:00Z, though it sorts after as text.
    const early = rev("x", "2026-10-05T09:00:00+02:00", 1);
    const late = rev("x", "2026-10-05T08:00:00Z", 3);
    expect(compareEvents(early, late)).toBeLessThan(0);
    expect(replay([late, early], OFF).get("x")!.lastGrade).toBe(3);
  });
});

describe("baselines", () => {
  it("seed a card that has no history", () => {
    const [state] = replay([base("x", "2026-10-01T10:00:00Z", 20, 5, 4)], OFF).values();
    expect(state).toEqual<CardState>({
      type: "reviewed",
      lastReviewedAt: "2026-10-01T10:00:00Z",
      stability: 20,
      difficulty: 5,
      reviewCount: 4,
      lastDay: "2026-10-01",
      lastGrade: null,
      intervalRaw: interval(0.9, 20),
      intervalDays: 20,
      dueDate: "2026-10-21",
    });
  });

  it("replace everything before them, and the latest one wins", () => {
    const events = [
      rev("x", "2026-09-01T10:00:00Z", 1),
      base("x", "2026-09-05T10:00:00Z", 3, 7, 2),
      rev("x", "2026-09-06T10:00:00Z", 1),
      base("x", "2026-09-10T10:00:00Z", 12, 4, 5),
    ];
    expect(replay(events, OFF).get("x")).toEqual(replay(events.slice(3), OFF).get("x"));
  });

  it("let later reviews carry on, counting the gap and the reps from the baseline", () => {
    const events = [base("x", "2026-09-10T10:00:00Z", 12, 4, 5), rev("x", "2026-09-22T10:00:00Z", 3)];
    const state = replay(events, OFF).get("x")!;
    const expected = step({ stability: 12, difficulty: 4, lastDay: "2026-09-10", reviewCount: 5 }, 3, "2026-09-22");
    expect(state).toMatchObject({
      stability: expected.stability,
      difficulty: expected.difficulty,
      reviewCount: 6,
      dueDate: expected.dueDate,
    });
  });

  it("win over a review at the same instant, being the state after it", () => {
    // Migration writes a baseline at the card's lastReviewedAt, which the v1
    // log also has as a review. Applying that review again would double it.
    const at = "2026-10-13T19:14:37.619Z";
    for (const events of [
      [rev("x", at, 4), base("x", at, 8.2956, 1, 1)],
      [base("x", at, 8.2956, 1, 1), rev("x", at, 4)],
    ]) {
      expect(replay(events, OFF).get("x")).toMatchObject({ stability: 8.2956, reviewCount: 1 });
    }
  });

  it("keep a recorded lapse due the same day, and read a missing grade as a pass", () => {
    const at = "2026-10-13T08:00:00Z";
    expect(replay([base("x", at, 0.2, 8, 3, { grade: 1 })], OFF).get("x")!.dueDate).toBe("2026-10-13");
    expect(replay([base("x", at, 0.2, 8, 3)], OFF).get("x")!.dueDate).toBe("2026-10-14");
  });

  it("without a tz, count days in the fallback zone", () => {
    // 22:30Z on 13 October is the 14th in Berlin summer time.
    const state = replay([base("x", "2026-10-13T22:30:00Z", 5, 5, 1, { tz: undefined })], OFF).get("x")!;
    expect(state.lastDay).toBe("2026-10-14");
  });
});

describe("retention", () => {
  it("moves every due date from the last review, and nothing else", () => {
    const at90 = replay(LOG, { fuzz: false, retention: 0.9 });
    const at80 = replay(LOG, { fuzz: false, retention: 0.8 });
    for (const [card, state] of at90) {
      const other = at80.get(card)!;
      expect(other.stability).toBe(state.stability);
      expect(other.difficulty).toBe(state.difficulty);
      const expected = schedule(state.stability, state.lastGrade, state.lastDay, state.reviewCount, {
        retention: 0.8,
      });
      expect(other.dueDate).toBe(expected.dueDate);
      expect(other.dueDate >= state.dueDate).toBe(true);
    }
    expect(at80.get("d")!.dueDate > at90.get("d")!.dueDate).toBe(true);
  });
});

describe("same-day rules", () => {
  it("keep a lapse due the same day and put a pass a day out", () => {
    const failed = replay([rev("x", "2026-04-02T10:00:00Z", 1)], OFF).get("x")!;
    expect(failed.dueDate).toBe("2026-04-02");
    const passed = replay([rev("x", "2026-04-02T10:00:00Z", 1), rev("x", "2026-04-02T10:05:00Z", 3)], OFF).get("x")!;
    expect(passed.dueDate).toBe("2026-04-03");
  });
});

describe("timezones", () => {
  it("come from the events, never the replaying device", () => {
    const saved = process.env.TZ;
    try {
      const machineDays = new Set<number>();
      const results = ["UTC", "Europe/Berlin", "Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"].map((tz) => {
        process.env.TZ = tz;
        // Proof the switch takes effect: the machine's own idea of the day of
        // a review late on 9 October UTC differs between these zones.
        machineDays.add(new Date("2026-10-09T22:30:00Z").getDate());
        return replay(LOG, { fuzz: true, retention: 0.9 });
      });
      expect(machineDays.size).toBeGreaterThan(1);
      for (const result of results) expect(result).toEqual(results[0]);
    } finally {
      process.env.TZ = saved;
    }
  });

  it("decide which day a review falls on, and so the gap", () => {
    // 20:00Z and 23:30Z on the 13th: the same day at UTC, a day apart in
    // Berlin (22:00 and 01:30), and in New York both on the 13th still.
    const pair = (tz: number) =>
      replay([rev("x", "2026-10-13T20:00:00Z", 3, tz), rev("x", "2026-10-13T23:30:00Z", 3, tz)], OFF).get("x")!;
    const first = step(null, 3, "2026-10-13");
    const prior = { ...first, lastDay: "2026-10-13" };
    expect(pair(120).stability).toBe(step(prior, 3, "2026-10-14").stability);
    expect(pair(0).stability).toBe(step(prior, 3, "2026-10-13").stability);
    expect(pair(-240).stability).toBe(step(prior, 3, "2026-10-13").stability);
    expect(pair(120).lastDay).toBe("2026-10-14");
    expect(pair(-240).lastDay).toBe("2026-10-13");
  });

  it("follow the traveller: each review is counted in the zone it was made in", () => {
    // Reviewed in Berlin on the 1st, then in New York late on the 2nd, local
    // time — which is already the 3rd at UTC.
    const state = replay([rev("x", "2026-10-01T10:00:00Z", 3, 120), rev("x", "2026-10-03T02:00:00Z", 3, -240)], OFF).get("x")!;
    expect(state.lastDay).toBe("2026-10-02");
  });
});

describe("fuzz", () => {
  it("is deterministic, and per card", () => {
    const on: ReplayOptions = { fuzz: true, retention: 0.9 };
    expect(replay(LOG, on)).toEqual(replay(shuffled(LOG, 7), on));
    // Over many cards with the same long interval, fuzz spreads them out.
    const many = Array.from({ length: 30 }, (_, i) => base(`card-${i}`, "2026-10-01T10:00:00Z", 60, 5, 3));
    const days = new Set([...replay(many, on).values()].map((s) => s.intervalDays));
    expect(days.size).toBeGreaterThan(3);
    for (const d of days) expect(Math.abs(d - 60)).toBeLessThanOrEqual(3);
    expect(new Set([...replay(many, OFF).values()].map((s) => s.intervalDays))).toEqual(new Set([60]));
  });
});

describe("incremental replay", () => {
  const sorted = [...LOG].sort(compareEvents);

  it("equals a full replay when the new events come after the old ones", () => {
    const full = replayAll(LOG, OFF);
    for (let cut = 0; cut <= sorted.length; cut++) {
      const prev = replayAll(sorted.slice(0, cut), OFF);
      const next = replayMore(prev, shuffled(sorted.slice(cut), cut), () => LOG, OFF);
      expect(next.replayedAll).toBe(false);
      expect(next.cards).toEqual(full.cards);
      expect(next.watermark).toEqual(full.watermark);
    }
  });

  it("replays everything when an older event turns up late", () => {
    // A phone that was offline delivers a review from before the watermark.
    const late = rev("a", "2026-10-02T09:00:00Z", 2);
    const prev = replayAll(LOG, OFF);
    const next = replayMore(prev, [late, rev("e", "2026-11-01T09:00:00Z", 3)], () => [...LOG, late, rev("e", "2026-11-01T09:00:00Z", 3)], OFF);
    expect(next.replayedAll).toBe(true);
    expect(next.cards).toEqual(replay([...LOG, late, rev("e", "2026-11-01T09:00:00Z", 3)], OFF));
    expect(next.cards.get("a")).not.toEqual(prev.cards.get("a"));
  });

  it("replays everything when the options change", () => {
    const prev = replayAll(LOG, OFF);
    const next = replayMore(prev, [], () => LOG, { fuzz: false, retention: 0.85 });
    expect(next.replayedAll).toBe(true);
    expect(next.cards).toEqual(replay(LOG, { fuzz: false, retention: 0.85 }));
  });

  it("skips the last event seen being delivered again, without a full replay", () => {
    const prev = replayAll(LOG, OFF);
    const last = sorted[sorted.length - 1];
    const next = replayMore(prev, [last], () => LOG, OFF);
    expect(next.replayedAll).toBe(false);
    expect(next.cards).toEqual(prev.cards);
  });

  it("starts from an empty replay", () => {
    const next = replayMore(replayAll([], OFF), LOG, () => LOG, OFF);
    expect(next.replayedAll).toBe(false);
    expect(next.cards).toEqual(replay(LOG, OFF));
  });

  it("leaves the previous result as it was", () => {
    const prev = replayAll(sorted.slice(0, 5), OFF);
    const copy = structuredClone(prev);
    replayMore(prev, sorted.slice(5), () => LOG, OFF);
    replayMore(prev, [rev("a", "2026-09-01T00:00:00Z", 1)], () => LOG, OFF);
    expect(prev).toEqual(copy);
  });

  it("survives a structured clone, as an IndexedDB cache would store it", () => {
    const prev: Replayed = structuredClone(replayAll(sorted.slice(0, 6), OFF));
    expect(replayMore(prev, sorted.slice(6), () => LOG, OFF).cards).toEqual(replay(LOG, OFF));
  });

  it("converges with a full replay as devices sync in any order", () => {
    // Three devices review a shared set of cards over two months. Each sync
    // delivers whatever another device has written since the last one, so
    // events routinely arrive older than what has already been replayed.
    const on: ReplayOptions = { fuzz: true, retention: 0.9 };
    const random = rng(42);
    const devices: ReviewLogEvent[][] = [[], [], []];
    const start = Date.parse("2026-09-01T06:00:00Z");
    for (let i = 0; i < 300; i++) {
      const at = new Date(start + Math.floor(random() * 60 * 86_400_000)).toISOString();
      const card = `card-${Math.floor(random() * 12)}`;
      const grade = (1 + Math.floor(random() * 4)) as GradeValue;
      devices[Math.floor(random() * 3)].push(rev(card, at, grade, random() < 0.8 ? 120 : -300));
    }
    for (const log of devices) log.sort(compareEvents);

    const delivered = devices.map(() => 0);
    const seen: ReviewLogEvent[] = [];
    let state = replayAll([], on);
    let fullReplays = 0;
    while (delivered.some((n, d) => n < devices[d].length)) {
      const d = Math.floor(random() * 3);
      const upto = Math.min(devices[d].length, delivered[d] + 1 + Math.floor(random() * 25));
      const batch = devices[d].slice(delivered[d], upto);
      delivered[d] = upto;
      seen.push(...batch);
      const next = replayMore(state, batch, () => seen, on);
      if (next.replayedAll) fullReplays++;
      state = next;
      expect(state.cards).toEqual(replay(seen, on));
    }
    expect(fullReplays).toBeGreaterThan(0);
    expect(state.cards).toEqual(replay(devices.flat(), on));
  });
});
