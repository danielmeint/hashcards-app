// Days are local days, so the tests pin a zone with a UTC offset — one where
// the old UTC-date arithmetic and the local calendar disagree around midnight.
process.env.TZ = "Europe/Berlin";

import { describe, it, expect } from "vitest";
import {
  PARAMETERS,
  interval,
  retrievability,
  updatePerformance,
  formatInterval,
} from "./fsrs";
import { Grade, Performance, ReviewedPerformance } from "./types";

function feq(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

/**
 * FSRS-6's state transition, transcribed from the reference implementation
 * (fsrs-rs `model_v6.rs`, `next_state_scalar`), as an oracle the library is
 * checked against. Kept deliberately literal.
 */
function reference(
  state: { s: number; d: number } | null,
  deltaT: number,
  g: number
): { s: number; d: number } {
  const w = PARAMETERS;
  const clampD = (d: number) => Math.min(10, Math.max(1, d));
  const initD = (r: number) => w[4] - Math.exp(w[5] * (r - 1)) + 1;
  if (!state) return { s: w[g - 1], d: clampD(initD(g)) };
  const { s, d } = state;
  const decay = -w[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  const r = Math.pow(1 + (factor * deltaT) / s, decay);
  let next: number;
  if (deltaT === 0) {
    const sinc = Math.exp(w[17] * (g - 3 + w[18])) * Math.pow(s, -w[19]);
    next = s * (g >= 2 ? Math.max(sinc, 1) : sinc);
  } else if (g === 1) {
    const floor = s / Math.exp(w[17] * w[18]);
    const fail =
      w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
    next = Math.min(fail, floor);
  } else {
    const hard = g === 2 ? w[15] : 1;
    const easy = g === 4 ? w[16] : 1;
    next =
      s *
      (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy +
        1);
  }
  const delta = -w[6] * (g - 3);
  const linear = d + ((10 - d) / 9) * delta;
  const reverted = w[7] * initD(4) + (1 - w[7]) * linear;
  return { s: next, d: clampD(reverted) };
}

/** Review a card through the app at each `[grade, ISO time]`, in order. */
function review(steps: [Grade, string][], start: Performance = { type: "new" }) {
  const out: ReviewedPerformance[] = [];
  let perf = start;
  for (const [grade, at] of steps) {
    perf = updatePerformance(perf, grade, at);
    out.push(perf);
  }
  return out;
}

describe("formatInterval", () => {
  it("formats sub-day as <1d", () => {
    expect(formatInterval(0)).toBe("<1d");
  });

  it("formats days", () => {
    expect(formatInterval(1)).toBe("1d");
    expect(formatInterval(7)).toBe("7d");
    expect(formatInterval(13)).toBe("13d");
  });

  it("formats weeks", () => {
    expect(formatInterval(14)).toBe("2w");
    expect(formatInterval(21)).toBe("3w");
    expect(formatInterval(28)).toBe("4w");
  });

  it("formats months", () => {
    expect(formatInterval(30)).toBe("1mo");
    expect(formatInterval(90)).toBe("3mo");
    expect(formatInterval(180)).toBe("6mo");
  });

  it("formats years", () => {
    expect(formatInterval(365)).toBe("1.0y");
    expect(formatInterval(730)).toBe("2.0y");
  });
});

describe("FSRS-6", () => {
  it("runs on the published FSRS-6 defaults", () => {
    expect(PARAMETERS).toHaveLength(21);
    expect(PARAMETERS[20]).toBe(0.1542);
  });

  it("puts recall at exactly 90% one stability out", () => {
    expect(feq(retrievability(7, 7), 0.9)).toBe(true);
    expect(feq(interval(0.9, 7), 7)).toBe(true);
  });

  it("matches the reference transition across days, grades and lapses", () => {
    const steps: [Grade, string][] = [
      [Grade.Good, "2026-04-01T10:00:00Z"],
      [Grade.Good, "2026-04-03T10:00:00Z"],
      [Grade.Hard, "2026-04-10T10:00:00Z"],
      [Grade.Forgot, "2026-05-02T10:00:00Z"],
      [Grade.Easy, "2026-05-04T10:00:00Z"],
      [Grade.Good, "2026-05-20T10:00:00Z"],
    ];
    const actual = review(steps);

    let state: { s: number; d: number } | null = null;
    let last: string | null = null;
    steps.forEach(([grade, at], i) => {
      const day = at.slice(0, 10); // 10:00Z is the same day in Berlin
      const deltaT = last ? Math.round((Date.parse(day) - Date.parse(last)) / 86_400_000) : 0;
      state = reference(state, deltaT, grade);
      last = day;
      expect(feq(actual[i].stability, state.s)).toBe(true);
      expect(feq(actual[i].difficulty, state.d)).toBe(true);
    });
  });

  it("carries a state written under FSRS-5 over as it is", () => {
    // Stability is the interval at 90% recall in both versions, so an existing
    // card needs no conversion — it simply continues under the new model.
    const fsrs5: Performance = {
      type: "reviewed",
      lastReviewedAt: "2026-04-01T10:00:00Z",
      stability: 10,
      difficulty: 5,
      intervalRaw: 10,
      intervalDays: 10,
      dueDate: "2026-04-11",
      reviewCount: 4,
    };
    const [next] = review([[Grade.Good, "2026-04-11T10:00:00Z"]], fsrs5);
    const expected = reference({ s: 10, d: 5 }, 10, Grade.Good);
    expect(feq(next.stability, expected.s)).toBe(true);
    expect(next.reviewCount).toBe(5);
  });
});

/**
 * A gap of zero days used to mean predicted recall of 1.0, which zeroes the
 * growth term — a card forgotten and re-learned the same day went nowhere, and
 * the workaround was to pretend a day had passed. FSRS-6 has its own formula
 * for the same day.
 */
describe("same-day reviews", () => {
  const forgotThen = (grade: Grade) =>
    review([
      [Grade.Forgot, "2026-04-02T08:00:00Z"],
      [grade, "2026-04-02T15:00:00Z"],
    ]);

  it("use the short-term formula, not a pretend day", () => {
    const [first, second] = forgotThen(Grade.Good);
    const expected = reference({ s: first.stability, d: first.difficulty }, 0, Grade.Good);
    expect(feq(second.stability, expected.s)).toBe(true);
  });

  it("never lose stability on a pass", () => {
    for (const grade of [Grade.Hard, Grade.Good, Grade.Easy]) {
      const [first, second] = forgotThen(grade);
      expect(second.stability).toBeGreaterThanOrEqual(first.stability);
    }
  });

  it("can lose it on a second lapse", () => {
    const [first, second] = forgotThen(Grade.Forgot);
    expect(second.stability).toBeLessThan(first.stability);
  });

  it("still update difficulty", () => {
    const [first, second] = forgotThen(Grade.Easy);
    expect(second.difficulty).toBeLessThan(first.difficulty);
  });

  it("leave a relearned card able to grow the next day", () => {
    const [, relearned] = forgotThen(Grade.Good);
    const [next] = review([[Grade.Good, "2026-04-03T08:00:00Z"]], relearned);
    expect(next.stability).toBeGreaterThan(relearned.stability);
    expect(next.intervalDays).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The April "stuck card": a card forgotten and then passed again and again on
 * the same day stayed due that same day. Under FSRS-5 it could never leave —
 * a 0-day gap zeroed stability growth. Under FSRS-6 it grows, but slowly, and
 * a 0-day interval still kept it due today for seven passes.
 */
describe("the same-day trap", () => {
  it("lets the production sequence leave the day it was failed", () => {
    const results = review([
      [Grade.Forgot, "2026-04-02T12:50:00Z"],
      [Grade.Forgot, "2026-04-02T12:54:00Z"],
      [Grade.Good, "2026-04-02T13:52:00Z"],
      [Grade.Good, "2026-04-02T14:33:00Z"],
      [Grade.Easy, "2026-04-02T14:45:00Z"],
    ]);
    const last = results[results.length - 1];
    expect(last.intervalDays).toBeGreaterThanOrEqual(1);
    expect(last.dueDate).not.toBe("2026-04-02");
  });

  it("needs one pass after a lapse, whichever pass it is", () => {
    for (const grade of [Grade.Hard, Grade.Good, Grade.Easy]) {
      const [, passed] = review([
        [Grade.Forgot, "2026-04-02T10:00:00Z"],
        [grade, "2026-04-02T10:05:00Z"],
      ]);
      expect(passed.dueDate).toBe("2026-04-03");
    }
  });

  it("keeps a failed weak card due today, for a later drill to retry", () => {
    const [failed] = review([[Grade.Forgot, "2026-04-02T10:00:00Z"]]);
    expect(failed.intervalDays).toBe(0);
    expect(failed.dueDate).toBe("2026-04-02");
  });

  it("does not inflate what was learned to get there", () => {
    // The day out is scheduling; the memory model still says the card is weak,
    // and tomorrow's review is what grows it.
    const [failed, passed] = review([
      [Grade.Forgot, "2026-04-02T10:00:00Z"],
      [Grade.Good, "2026-04-02T10:05:00Z"],
    ]);
    const expected = reference({ s: failed.stability, d: failed.difficulty }, 0, Grade.Good);
    expect(feq(passed.stability, expected.s)).toBe(true);
    expect(passed.stability).toBeLessThan(0.5);
    const [tomorrow] = review([[Grade.Good, "2026-04-03T10:00:00Z"]], passed);
    expect(tomorrow.stability).toBeGreaterThan(1);
  });
});

/**
 * Due dates are compared with the local day, so the review's day has to be the
 * local day too. It was the UTC date of the timestamp.
 */
describe("days are local days", () => {
  it("dates a review after local midnight to that day, not the UTC one before it", () => {
    // 00:30 in Berlin on the 14th is 22:30 UTC on the 13th.
    const [card] = review([[Grade.Good, "2026-10-13T22:30:00Z"]]);
    expect(card.dueDate > "2026-10-14").toBe(true);
    expect(card.dueDate).toBe(`2026-10-${14 + card.intervalDays}`);
  });

  it("counts reviews either side of local midnight as a day apart", () => {
    // 22:00 and 00:30 local: the same UTC date, different days where you are.
    const [first, second] = review([
      [Grade.Good, "2026-10-13T20:00:00Z"],
      [Grade.Good, "2026-10-13T22:30:00Z"],
    ]);
    const nextDay = reference({ s: first.stability, d: first.difficulty }, 1, Grade.Good);
    expect(feq(second.stability, nextDay.s)).toBe(true);
  });
});

describe("desired retention", () => {
  // A card reviewed Good twice, ten days apart: stable enough that the
  // interval is far from both rounding and the clamp.
  const reviewed = (retention?: number) =>
    updatePerformance(
      updatePerformance({ type: "new" }, Grade.Good, "2026-04-01T10:00:00Z"),
      Grade.Good,
      "2026-04-11T10:00:00Z",
      retention === undefined ? {} : { retention }
    );

  it("defaults to 90%, where the interval is the stability itself", () => {
    const perf = reviewed();
    expect(feq(perf.intervalRaw, perf.stability)).toBe(true);
    expect(reviewed(0.9)).toEqual(perf);
  });

  it("schedules further out for less, and sooner for more", () => {
    const at90 = reviewed(0.9).intervalRaw;
    expect(reviewed(0.8).intervalRaw).toBeGreaterThan(at90);
    expect(reviewed(0.95).intervalRaw).toBeLessThan(at90);
  });

  it("is the interval at which predicted recall falls to the target", () => {
    const perf = reviewed(0.8);
    expect(feq(retrievability(perf.intervalRaw, perf.stability), 0.8)).toBe(true);
  });

  it("changes when a card is due, not what was learned about it", () => {
    const [low, high] = [reviewed(0.8), reviewed(0.95)];
    expect(low.stability).toBe(high.stability);
    expect(low.difficulty).toBe(high.difficulty);
  });
});
