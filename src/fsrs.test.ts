import { describe, it, expect } from "vitest";
import {
  initialStability,
  initialDifficulty,
  newStability,
  newDifficulty,
  interval,
  retrievability,
} from "./fsrs";
import { Grade } from "./types";

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
