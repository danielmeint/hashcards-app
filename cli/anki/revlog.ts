/**
 * Anki review log -> hashcards v2 review events (PLAN-1.0.md §2.4), and
 * Anki's scheduling numbers -> dates. All pure.
 */

/**
 * `revlog.type`, from Anki's rslib `RevlogReviewKind`.
 *
 * Only real answers to a card belong in the log hashcards replays: learning,
 * review and relearning. The others are not memory evidence:
 * - 3 Filtered: a review in a filtered deck. Anki's FSRS keeps it only when
 *   the deck reschedules (the entry then carries an ease factor); with
 *   rescheduling off it is "cram" and is ignored. Same rule here.
 * - 4 Manual: "Set due date" / "Forget", written with ease 0.
 * - 5 Rescheduled: FSRS "reschedule cards on change", also ease 0.
 */
export const REVLOG_TYPES = {
  0: "learn",
  1: "review",
  2: "relearn",
  3: "filtered",
  4: "manual",
  5: "rescheduled",
} as const;

export type RevlogRow = {
  /** Epoch milliseconds of the answer. Also the primary key. */
  id: number;
  cid: number;
  /** Button: 1 Again, 2 Hard, 3 Good, 4 Easy. 0 for non-answers. */
  ease: number;
  /** Milliseconds on the card. Anki caps this at the deck's `maxTaken` (60 s by default). */
  time: number;
  type: number;
  /** Ease factor (permille); 0 for a cram review in a filtered deck. */
  factor: number;
};

export type SkipReason =
  | "cram (filtered deck without rescheduling)"
  | "manual (set due date / forget)"
  | "rescheduled"
  | "not an answer (ease 0)"
  | "unknown revlog type";

export type Classified = { grade: 1 | 2 | 3 | 4 } | { skip: SkipReason };

/**
 * Whether a revlog row is a review to import, and with which grade.
 *
 * Anki's ease 1–4 is hashcards' grade 1–4 (Forgot/Again, Hard, Good, Easy) on
 * the v2 and v3 schedulers. The v1 scheduler had three buttons while learning,
 * where ease 3 meant Easy. The importer refuses v1 collections up front (see
 * `checkScheduler`) instead of guessing per row.
 */
export function classifyRevlog(row: Pick<RevlogRow, "ease" | "type" | "factor">): Classified {
  switch (row.type) {
    case 0:
    case 1:
    case 2:
      break;
    case 3:
      if (row.factor === 0) return { skip: "cram (filtered deck without rescheduling)" };
      break;
    case 4:
      return { skip: "manual (set due date / forget)" };
    case 5:
      return { skip: "rescheduled" };
    default:
      return { skip: "unknown revlog type" };
  }
  if (row.ease < 1 || row.ease > 4) return { skip: "not an answer (ease 0)" };
  return { grade: row.ease as 1 | 2 | 3 | 4 };
}

/** The v1 scheduler's learning ease means something else (see above). */
export function checkScheduler(schedVer: number | null): string | null {
  if (schedVer === null || schedVer >= 2) return null;
  return `collection uses Anki's v1 scheduler (schedVer ${schedVer}); its learning-step ease values are not 1-4 grades`;
}

/**
 * Anki's own default `maxTaken`. A longer review is walking away, not
 * thinking, and Anki has already clipped most rows to this.
 */
export const DEFAULT_MAX_MS = 60_000;

export function capMs(time: number, maxMs = DEFAULT_MAX_MS): number {
  return Math.max(0, Math.min(Math.round(time), maxMs));
}

// --------------------------------------------------------------------------
// Time zones

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * UTC offset in minutes of `timeZone` at the instant `epochMs`: +60 for CET,
 * +120 for CEST.
 *
 * Anki stores no time zone with a review, so the importer assumes one
 * (Europe/Berlin by default; Oslo is the same zone). Computing the offset per
 * instant is what makes DST right: a review at 01:30 UTC on the last Sunday of
 * October is +120 before the switch and +60 after, and an ambiguous local
 * 02:30 cannot arise because we start from the UTC instant.
 */
export function tzOffsetMinutes(epochMs: number, timeZone: string): number {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatters.set(timeZone, fmt);
  }
  const name = fmt.formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName")?.value;
  // "GMT+02:00", "GMT-03:30", or plain "GMT" for UTC itself.
  const m = name?.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);
  if (!m) throw new Error(`Cannot read the UTC offset of ${timeZone}: got "${name}"`);
  if (!m[1]) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The local wall-clock date and time at `epochMs`, as a UTC-based Date. */
function localWallClock(epochMs: number, tz: number): Date {
  return new Date(epochMs + tz * 60_000);
}

/** `YYYY-MM` of the local month, which names the event file. */
export function localMonth(epochMs: number, tz: number): string {
  return localWallClock(epochMs, tz).toISOString().slice(0, 7);
}

/** `YYYY-MM-DD` of the local calendar date. */
export function localDate(epochMs: number, tz: number): string {
  return localWallClock(epochMs, tz).toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Events

export type ReviewEvent = {
  v: 2;
  card: string;
  at: string;
  tz: number;
  grade: 1 | 2 | 3 | 4;
  ms: number;
  src: "anki";
};

/** Key order is fixed, so the JSONL output is byte-stable between runs. */
export function toEvent(
  row: Pick<RevlogRow, "id" | "time">,
  card: string,
  grade: 1 | 2 | 3 | 4,
  timeZone: string,
  maxMs = DEFAULT_MAX_MS
): ReviewEvent {
  return {
    v: 2,
    card,
    at: new Date(row.id).toISOString(),
    tz: tzOffsetMinutes(row.id, timeZone),
    grade,
    ms: capMs(row.time, maxMs),
    src: "anki",
  };
}

// --------------------------------------------------------------------------
// Anki's day numbers

/** Epoch seconds above this are timestamps; below, day numbers. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;

/**
 * The calendar date of Anki's day 0.
 *
 * Review cards store `due` as days since the collection was created, where a
 * day starts at the rollover hour (4 a.m. by default), not midnight. `crt` is
 * the creation timestamp, already placed at a rollover. Shifting it back by
 * the rollover hours and reading the local date gives the calendar date of
 * day 0. A card due on day n is due on that date + n.
 */
export function dayZero(crtSeconds: number, rolloverHour: number, timeZone: string): string {
  const ms = crtSeconds * 1000 - rolloverHour * 3_600_000;
  return localDate(ms, tzOffsetMinutes(ms, timeZone));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type AnkiCardRow = {
  type: number;
  queue: number;
  due: number;
  odue: number;
  odid: number;
};

export type AnkiDue =
  | { kind: "new"; position: number }
  | { kind: "day"; date: string }
  | { kind: "time"; at: string; date: string };

/**
 * Turn `cards.due` into a date.
 *
 * Its meaning depends on the queue: a new-card position, a day number
 * (review and interday learning) or epoch seconds (intraday learning). Cards
 * in a filtered deck keep their real due in `odue`. Suspended and buried cards
 * keep the due of their underlying type, so `type` decides.
 */
export function ankiDue(card: AnkiCardRow, crtSeconds: number, rolloverHour: number, timeZone: string): AnkiDue {
  const due = card.odid ? card.odue : card.due;
  if (card.type === 0) return { kind: "new", position: due };
  if (due > EPOCH_SECONDS_FLOOR) {
    const ms = due * 1000;
    return { kind: "time", at: new Date(ms).toISOString(), date: localDate(ms, tzOffsetMinutes(ms, timeZone)) };
  }
  return { kind: "day", date: addDays(dayZero(crtSeconds, rolloverHour, timeZone), due) };
}
