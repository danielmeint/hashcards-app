/**
 * The review log, line by line.
 *
 * In 1.0 the log is the source of truth: a card's state is whatever replaying
 * its events gives (`src/core/replay.ts`). Each device appends to its own
 * month files, one JSON object per line, with short keys because these files
 * only grow:
 *
 *     {"v":2,"card":"est-capital","at":"2026-10-15T07:12:03.120Z","tz":120,"grade":3,"ms":4200}
 *     {"v":2,"kind":"baseline","card":"k3n9wq2p:1","at":"2026-10-13T19:14:37.619Z","s":8.2956,"d":1,"reps":1}
 *
 * A `review` is a grade given. A `baseline` stands in for history that is not
 * available — the v1 state file knew where a card was, not how it got there —
 * and resets the card to that stability and difficulty from then on.
 *
 * The v1 log (`src/review-log.ts`) is read too, as reviews with `src: "v1"`.
 * Its `card` is the v1 content hash; mapping that to a v2 key is migration's
 * job, not the parser's.
 *
 * Parsing is strict about every field it knows — a grade of 5 or a `tz` of
 * "+02:00" is an error, not a guess — and a bad line is reported, never
 * thrown, so one corrupt line cannot cost a file's worth of reviews. Keys it
 * does not know are ignored: an installed PWA can be a version behind the
 * device that wrote the file, and dropping a review over a field added later
 * would be worse than not reading that field. A change old readers must not
 * misread bumps `v` instead, which they do reject.
 */

/** Recorded by the app, by `hc`, by an importer: `"anki"`, `"v1"`, … */
export type Source = string;

export type ReviewEvent = {
  v: 2;
  kind: "review";
  /** The card's key (`src/core/` treats it as opaque), or a v1 hash. */
  card: string;
  /** ISO 8601 instant. */
  at: string;
  /** Local UTC offset in minutes at review time, east positive (Berlin summer is 120). */
  tz: number;
  grade: 1 | 2 | 3 | 4;
  /** How long the card was on screen before the grade. */
  ms?: number;
  src?: Source;
};

export type BaselineEvent = {
  v: 2;
  kind: "baseline";
  card: string;
  /** When the card was last reviewed, as far as the baseline knows. */
  at: string;
  /** As on a review. Optional: the v1 state file never recorded it. */
  tz?: number;
  s: number;
  d: number;
  /** Reviews the baseline stands for; later reviews count on from here. */
  reps: number;
  /**
   * The grade of the review the baseline stands for, when known. Only the
   * same-day rule uses it: a lapse may be due the day it happened, a pass may
   * not. Absent is read as a pass.
   */
  grade?: 1 | 2 | 3 | 4;
  src?: Source;
};

export type ReviewLogEvent = ReviewEvent | BaselineEvent;

export type ParseOptions = {
  /**
   * The UTC offset to assume for a v1 line, which never recorded one. See
   * `fallbackTz`.
   */
  v1Tz?: (at: string) => number;
};

export type LineResult =
  | { ok: true; event: ReviewLogEvent }
  | { ok: false; error: string };

export type LineError = {
  /** 1-based, as an editor counts lines. */
  line: number;
  text: string;
  error: string;
};

// --- The v1 timezone fallback -----------------------------------------------

/**
 * The UTC offset assumed for an event that did not record one: Central
 * European Time, +60 in winter and +120 in summer, by the EU rule (summer time
 * from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday
 * of October).
 *
 * The v1 app counted days in whatever zone the device was in, and did not
 * write it down. The one thing replay must not do is use the replaying
 * device's zone instead — then two phones in different zones would compute
 * different due dates from the same log. So the guess has to be a fixed one,
 * and the only v1 user so far has only ever reviewed in Munich and Oslo, both
 * on CET. It is computed rather than looked up through `Intl` so that it does
 * not depend on the runtime's time zone database either.
 *
 * Only v1 lines and `tz`-less baselines use this. Migration (M4) rewrites v1
 * lines as v2 with this offset made explicit, after which nothing depends on
 * the guess any more.
 */
export function fallbackTz(at: string): number {
  const ms = Date.parse(at);
  const year = new Date(ms).getUTCFullYear();
  const start = lastSundayAt1Utc(year, 2);
  const end = lastSundayAt1Utc(year, 9);
  return ms >= start && ms < end ? 120 : 60;
}

/** 01:00 UTC on the last Sunday of `month` (0-based) of `year`, in ms. */
function lastSundayAt1Utc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 1));
  lastDay.setUTCDate(lastDay.getUTCDate() - lastDay.getUTCDay());
  return lastDay.getTime();
}

// --- Parsing ----------------------------------------------------------------

/**
 * An ISO 8601 instant with an explicit zone, as `Date.prototype.toISOString`
 * and Anki-import tools produce. A date alone, or a time with no zone, would
 * be read in the parsing device's zone — exactly the dependency replay must
 * not have.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const V1_HASH = /^[0-9a-f]{64}$/;

/** UTC−12 to UTC+14: every offset in use. */
const MIN_TZ = -12 * 60;
const MAX_TZ = 14 * 60;

class LineProblem extends Error {}

function fail(message: string): never {
  throw new LineProblem(message);
}

type Fields = Record<string, unknown>;

function str(o: Fields, key: string): string {
  const value = o[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`"${key}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optStr(o: Fields, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key);
}

function instant(o: Fields, key: string): string {
  const value = str(o, key);
  if (!INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`"${key}" must be an ISO 8601 instant with a zone, got ${JSON.stringify(value)}`);
  }
  return value;
}

function int(o: Fields, key: string, min: number, max: number): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`"${key}" must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optInt(o: Fields, key: string, min: number, max: number): number | undefined {
  return o[key] === undefined ? undefined : int(o, key, min, max);
}

function num(o: Fields, key: string, check: (n: number) => boolean, want: string): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !check(value)) {
    fail(`"${key}" must be ${want}, got ${JSON.stringify(value)}`);
  }
  return value;
}

const grade = (o: Fields) => int(o, "grade", 1, 4) as 1 | 2 | 3 | 4;
const optGrade = (o: Fields) => optInt(o, "grade", 1, 4) as 1 | 2 | 3 | 4 | undefined;
const optMs = (o: Fields) => optInt(o, "ms", 0, Number.MAX_SAFE_INTEGER);

/** Drop `undefined`s, so a parsed event deep-equals one built by hand. */
function compact<T extends object>(o: T): T {
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (o[key] === undefined) delete o[key];
  }
  return o;
}

function parseV2(o: Fields): ReviewLogEvent {
  const kind = o.kind ?? "review";
  if (kind === "review") {
    return compact<ReviewEvent>({
      v: 2,
      kind: "review",
      card: str(o, "card"),
      at: instant(o, "at"),
      tz: int(o, "tz", MIN_TZ, MAX_TZ),
      grade: grade(o),
      ms: optMs(o),
      src: optStr(o, "src"),
    });
  }
  if (kind === "baseline") {
    return compact<BaselineEvent>({
      v: 2,
      kind: "baseline",
      card: str(o, "card"),
      at: instant(o, "at"),
      tz: optInt(o, "tz", MIN_TZ, MAX_TZ),
      // FSRS's own bounds: stability is positive, difficulty runs 1 to 10.
      s: num(o, "s", (n) => n > 0, "a positive number"),
      d: num(o, "d", (n) => n >= 1 && n <= 10, "a number from 1 to 10"),
      reps: int(o, "reps", 0, Number.MAX_SAFE_INTEGER),
      grade: optGrade(o),
      src: optStr(o, "src"),
    });
  }
  return fail(`unknown "kind" ${JSON.stringify(kind)}`);
}

/**
 * A v1 line: `{"card":<sha256>,"at","grade","s","d","ms"?}`. Its `s` and `d`
 * are what the live path computed at the time; replay recomputes them, so they
 * are checked for shape and then left behind.
 */
function parseV1(o: Fields, options: ParseOptions): ReviewEvent {
  const card = str(o, "card");
  if (!V1_HASH.test(card)) fail(`a v1 "card" must be a 64-digit hex hash, got ${JSON.stringify(card)}`);
  const at = instant(o, "at");
  num(o, "s", (n) => n > 0, "a positive number");
  num(o, "d", (n) => n >= 1 && n <= 10, "a number from 1 to 10");
  return compact<ReviewEvent>({
    v: 2,
    kind: "review",
    card,
    at,
    tz: (options.v1Tz ?? fallbackTz)(at),
    grade: grade(o),
    ms: optMs(o),
    src: "v1",
  });
}

/** One line of a log file, v2 or v1. Never throws. */
export function parseLine(line: string, options: ParseOptions = {}): LineResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "not a JSON object" };
  }
  const o = value as Fields;
  try {
    if (o.v === undefined) return { ok: true, event: parseV1(o, options) };
    if (o.v === 2) return { ok: true, event: parseV2(o) };
    return { ok: false, error: `unsupported version "v": ${JSON.stringify(o.v)}` };
  } catch (e) {
    if (e instanceof LineProblem) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * A whole file, as its text or its lines. Blank lines are skipped — every file
 * ends with a newline — and every other line either becomes an event or is
 * reported with its line number. A file's good lines are never held back by a
 * bad one.
 */
export function parseFile(
  file: string | readonly string[],
  options: ParseOptions = {}
): { events: ReviewLogEvent[]; errors: LineError[] } {
  const lines = typeof file === "string" ? file.split(/\r?\n/) : file;
  const events: ReviewLogEvent[] = [];
  const errors: LineError[] = [];
  lines.forEach((text, i) => {
    if (text.trim() === "") return;
    const result = parseLine(text, options);
    if (result.ok) events.push(result.event);
    else errors.push({ line: i + 1, text, error: result.error });
  });
  return { events, errors };
}

// --- Serialising ------------------------------------------------------------

/**
 * One event as a v2 line, keys in a fixed order and optional ones left out, so
 * the same event is always the same bytes. `kind` is written only for
 * baselines; a line without one is a review.
 */
export function serializeEvent(event: ReviewLogEvent): string {
  if (event.kind === "review") {
    return JSON.stringify({
      v: 2,
      card: event.card,
      at: event.at,
      tz: event.tz,
      grade: event.grade,
      ms: event.ms,
      src: event.src,
    });
  }
  return JSON.stringify({
    v: 2,
    kind: "baseline",
    card: event.card,
    at: event.at,
    tz: event.tz,
    s: event.s,
    d: event.d,
    reps: event.reps,
    grade: event.grade,
    src: event.src,
  });
}

/** A whole file: one line per event, newline-terminated. */
export function serializeFile(events: readonly ReviewLogEvent[]): string {
  return events.map((e) => serializeEvent(e) + "\n").join("");
}
