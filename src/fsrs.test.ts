import { describe, it, expect } from "vitest";
import {
  initialStability,
  initialDifficulty,
  newStability,
  newDifficulty,
  interval,
  retrievability,
  updatePerformance,
} from "./fsrs";
import { Grade, Performance, ReviewedPerformance } from "./types";

function feq(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

type Step = { t: number; s: number; d: number; i: number };

function sim(grades: Grade[]): Step[] {
  let t = 0;
  const rd = 0.9;
  const steps: Step[] = [];

  const g0 = grades[0];
  let s = initialStability(g0);
  let d = initialDifficulty(g0);
  let i = Math.max(Math.round(interval(rd, s)), 1);
  steps.push({ t, s, d, i });

  for (let idx = 1; idx < grades.length; idx++) {
    const g = grades[idx];
    t += i;
    const r = retrievability(i, s);
    s = newStability(d, s, r, g);
    d = newDifficulty(d, g);
    i = Math.max(Math.round(interval(rd, s)), 1);
    steps.push({ t, s, d, i });
  }

  return steps;
}

function assertSteps(actual: Step[], expected: Step[]) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(feq(actual[i].t, expected[i].t)).toBe(true);
    expect(feq(actual[i].s, expected[i].s)).toBe(true);
    expect(feq(actual[i].d, expected[i].d)).toBe(true);
    expect(feq(actual[i].i, expected[i].i)).toBe(true);
  }
}

describe("FSRS", () => {
  it("interval equals stability at R=0.9", () => {
    for (let i = 0; i < 100; i++) {
      const s = 0.1 + i * ((5.0 - 0.1) / 99);
      expect(feq(interval(0.9, s), s)).toBe(true);
    }
  });

  it("initial difficulty of Forgot equals W[4]", () => {
    expect(initialDifficulty(Grade.Forgot)).toBe(7.1949);
  });

  it("test_3e - three easies", () => {
    const g = Grade.Easy;
    const actual = sim([g, g, g]);
    assertSteps(actual, [
      { t: 0, s: 15.69, d: 3.22, i: 16 },
      { t: 16, s: 150.28, d: 2.13, i: 150 },
      { t: 166, s: 1252.22, d: 1.0, i: 1252 },
    ]);
  });

  it("test_3g - three goods", () => {
    const g = Grade.Good;
    const actual = sim([g, g, g]);
    assertSteps(actual, [
      { t: 0, s: 3.17, d: 5.28, i: 3 },
      { t: 3, s: 10.73, d: 5.27, i: 11 },
      { t: 14, s: 34.57, d: 5.26, i: 35 },
    ]);
  });

  it("test_2h - two hards", () => {
    const g = Grade.Hard;
    const actual = sim([g, g]);
    assertSteps(actual, [
      { t: 0, s: 1.18, d: 6.48, i: 1 },
      { t: 1, s: 1.7, d: 7.04, i: 2 },
    ]);
  });

  it("test_2f - two forgots", () => {
    const g = Grade.Forgot;
    const actual = sim([g, g]);
    assertSteps(actual, [
      { t: 0, s: 0.4, d: 7.19, i: 1 },
      { t: 1, s: 0.26, d: 8.08, i: 1 },
    ]);
  });

  it("test_gf - good then forgot", () => {
    const actual = sim([Grade.Good, Grade.Forgot]);
    assertSteps(actual, [
      { t: 0, s: 3.17, d: 5.28, i: 3 },
      { t: 3, s: 1.06, d: 6.8, i: 1 },
    ]);
  });
});

// Helper: chain updatePerformance calls with explicit timestamps
function chain(
  grades: { grade: Grade; at: string }[]
): ReviewedPerformance[] {
  const results: ReviewedPerformance[] = [];
  let perf: Performance = { type: "new" };
  for (const { grade, at } of grades) {
    const next = updatePerformance(perf, grade, at);
    results.push(next);
    perf = next;
  }
  return results;
}

describe("same-day re-reviews", () => {
  it("Forgot then same-day Easy escapes the 0-day trap", () => {
    const results = chain([
      { grade: Grade.Forgot, at: "2026-04-02T10:00:00Z" },
      { grade: Grade.Easy, at: "2026-04-02T10:05:00Z" },
    ]);
    // After Forgot: stability = W[0] = 0.40, intervalDays = 0
    expect(results[0].stability).toBeCloseTo(0.40255, 2);
    expect(results[0].intervalDays).toBe(0);
    expect(results[0].dueDate).toBe("2026-04-02");

    // After same-day Easy: stability must grow, interval must be >= 1
    expect(results[1].stability).toBeGreaterThan(results[0].stability);
    expect(results[1].intervalDays).toBeGreaterThanOrEqual(1);
    expect(results[1].dueDate).not.toBe("2026-04-02");
  });

  it("Forgot then same-day Good also escapes", () => {
    const results = chain([
      { grade: Grade.Forgot, at: "2026-04-02T10:00:00Z" },
      { grade: Grade.Good, at: "2026-04-02T10:05:00Z" },
    ]);
    expect(results[1].stability).toBeGreaterThan(results[0].stability);
    expect(results[1].intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("Forgot then same-day Hard also escapes", () => {
    const results = chain([
      { grade: Grade.Forgot, at: "2026-04-02T10:00:00Z" },
      { grade: Grade.Hard, at: "2026-04-02T10:05:00Z" },
    ]);
    expect(results[1].stability).toBeGreaterThan(results[0].stability);
    expect(results[1].intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("repeated same-day Easy keeps increasing stability", () => {
    const results = chain([
      { grade: Grade.Forgot, at: "2026-04-02T10:00:00Z" },
      { grade: Grade.Easy, at: "2026-04-02T10:01:00Z" },
      { grade: Grade.Easy, at: "2026-04-02T10:02:00Z" },
      { grade: Grade.Easy, at: "2026-04-02T10:03:00Z" },
    ]);
    // Each successive Easy should keep growing stability
    for (let i = 1; i < results.length; i++) {
      expect(results[i].stability).toBeGreaterThan(results[i - 1].stability);
    }
    // Should definitely not be stuck at dueDate = today
    expect(results[3].intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("same-day Forgot still resets stability (no artificial boost)", () => {
    const results = chain([
      { grade: Grade.Good, at: "2026-04-02T10:00:00Z" },
      { grade: Grade.Forgot, at: "2026-04-02T10:05:00Z" },
    ]);
    // Forgot should reduce stability, not benefit from the time=1 boost
    expect(results[1].stability).toBeLessThan(results[0].stability);
  });

  it("reproduces the stuck-card scenario from production", () => {
    // Simulate what happened: Forgot, then 5 more reviews on the same day
    // Before the fix, stability stayed at 0.40 forever
    const results = chain([
      { grade: Grade.Forgot, at: "2026-04-02T12:50:00Z" },
      { grade: Grade.Forgot, at: "2026-04-02T12:54:00Z" },
      { grade: Grade.Good, at: "2026-04-02T13:52:00Z" },
      { grade: Grade.Good, at: "2026-04-02T14:33:00Z" },
      { grade: Grade.Easy, at: "2026-04-02T14:45:00Z" },
    ]);
    // After the Good/Easy grades, should have escaped
    const last = results[results.length - 1];
    expect(last.stability).toBeGreaterThan(0.41);
    expect(last.intervalDays).toBeGreaterThanOrEqual(1);
    expect(last.dueDate).not.toBe("2026-04-02");
  });

  it("normal next-day review still works as before", () => {
    const results = chain([
      { grade: Grade.Good, at: "2026-04-01T10:00:00Z" },
      { grade: Grade.Good, at: "2026-04-04T10:00:00Z" },
    ]);
    // 3 days later (matching interval), stability should grow
    expect(results[1].stability).toBeGreaterThan(results[0].stability);
    expect(results[1].intervalDays).toBeGreaterThan(results[0].intervalDays);
  });

  it("difficulty decreases with Easy and increases with Forgot", () => {
    const forgotChain = chain([
      { grade: Grade.Good, at: "2026-04-01T10:00:00Z" },
      { grade: Grade.Forgot, at: "2026-04-01T10:05:00Z" },
    ]);
    expect(forgotChain[1].difficulty).toBeGreaterThan(forgotChain[0].difficulty);

    const easyChain = chain([
      { grade: Grade.Good, at: "2026-04-01T10:00:00Z" },
      { grade: Grade.Easy, at: "2026-04-01T10:05:00Z" },
    ]);
    expect(easyChain[1].difficulty).toBeLessThan(easyChain[0].difficulty);
  });
});
