import { Grade, Performance, ReviewedPerformance } from "./types";

const W: number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655,
  0.6621,
];

const F = 19.0 / 81.0;
const C = -0.5;

const TARGET_RECALL = 0.9;
const MIN_INTERVAL = 1.0;
const MAX_INTERVAL = 256.0;

export function retrievability(t: number, s: number): number {
  return Math.pow(1.0 + F * (t / s), C);
}

export function interval(rd: number, s: number): number {
  return (s / F) * (Math.pow(rd, 1.0 / C) - 1.0);
}

export function initialStability(g: Grade): number {
  switch (g) {
    case Grade.Forgot:
      return W[0];
    case Grade.Hard:
      return W[1];
    case Grade.Good:
      return W[2];
    case Grade.Easy:
      return W[3];
  }
}

function sSuccess(d: number, s: number, r: number, g: Grade): number {
  const td = 11.0 - d;
  const ts = Math.pow(s, -W[9]);
  const tr = Math.exp(W[10] * (1.0 - r)) - 1.0;
  const h = g === Grade.Hard ? W[15] : 1.0;
  const b = g === Grade.Easy ? W[16] : 1.0;
  const c = Math.exp(W[8]);
  const alpha = 1.0 + td * ts * tr * h * b * c;
  return s * alpha;
}

function sFail(d: number, s: number, r: number): number {
  const df = Math.pow(d, -W[12]);
  const sf = Math.pow(s + 1.0, W[13]) - 1.0;
  const rf = Math.exp(W[14] * (1.0 - r));
  const cf = W[11];
  const result = df * sf * rf * cf;
  return Math.min(result, s);
}

export function newStability(
  d: number,
  s: number,
  r: number,
  g: Grade
): number {
  if (g === Grade.Forgot) {
    return sFail(d, s, r);
  } else {
    return sSuccess(d, s, r, g);
  }
}

function clampD(d: number): number {
  return Math.max(1.0, Math.min(10.0, d));
}

export function initialDifficulty(g: Grade): number {
  const gf = g as number;
  return clampD(W[4] - Math.exp(W[5] * (gf - 1.0)) + 1.0);
}

export function newDifficulty(d: number, g: Grade): number {
  return clampD(W[7] * initialDifficulty(Grade.Easy) + (1.0 - W[7]) * dp(d, g));
}

function dp(d: number, g: Grade): number {
  return d + deltaD(g) * ((10.0 - d) / 9.0);
}

function deltaD(g: Grade): number {
  const gf = g as number;
  return -W[6] * (gf - 3.0);
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

export function todayStr(): string {
  const now = new Date();
  return (
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0")
  );
}

export function updatePerformance(
  perf: Performance,
  grade: Grade,
  reviewedAt: string
): ReviewedPerformance {
  const today = reviewedAt.slice(0, 10);
  let stability: number;
  let difficulty: number;
  let reviewCount: number;

  if (perf.type === "new") {
    stability = initialStability(grade);
    difficulty = initialDifficulty(grade);
    reviewCount = 0;
  } else {
    const lastDate = perf.lastReviewedAt.slice(0, 10);
    const time = daysBetween(lastDate, today);
    const retr = retrievability(time, perf.stability);
    stability = newStability(perf.difficulty, perf.stability, retr, grade);
    difficulty = newDifficulty(perf.difficulty, grade);
    reviewCount = perf.reviewCount;
  }

  const intervalRaw = interval(TARGET_RECALL, stability);
  const intervalRounded = Math.round(intervalRaw);
  const intervalClamped = Math.max(
    MIN_INTERVAL,
    Math.min(MAX_INTERVAL, intervalRounded)
  );
  const intervalDays = intervalClamped;
  const dueDate = addDays(today, intervalDays);

  return {
    type: "reviewed",
    lastReviewedAt: reviewedAt,
    stability,
    difficulty,
    intervalRaw,
    intervalDays,
    dueDate,
    reviewCount: reviewCount + 1,
  };
}
