import { formatKey, formerKeys } from "./card-key";
import { parseFile } from "./parser";
import {
  BaselineEvent,
  LinkEvent,
  ReviewEvent,
  ReviewLogEvent,
  fallbackTz,
  parseFile as parseLog,
} from "./core/events";
import { CardState, replay } from "./core/replay";
import { stripIds } from "./card-ids";
import { ParsedCard } from "./types";
import {
  DEFAULT_RETENTION,
  FORGOT,
  MAX_RETENTION,
  MIN_RETENTION,
  PARAMETERS,
  dayAt,
  daysBetween,
  interval,
} from "./core/schedule";
import { MIGRATED_DEVICE, monthFiles } from "./core/month-files";

/**
 * Moving a v1 collection to 1.0 (PLAN-1.0 M4), as data in and data out: no
 * file system, no git. `hc migrate` reads the repo, hands it here, shows the
 * plan, and commits it; tests (the app's among them) feed it fixtures.
 *
 * A v1 collection keys everything by its v1 content hash: the state file says
 * where each card was at its last review, and each device's monthly log says
 * what it graded. 1.0 keys by a whitespace-normalised hash (PLAN-1.0 §2.7). So
 * the migration is two steps, and a check:
 *
 * 1. **Map hashes to keys.** Every deck is parsed, which gives each card both
 *    its v1 hash and its key. The deck files themselves do not change.
 * 2. **Re-key the history.** Each state-file entry becomes a `baseline`, each
 *    log line a v2 review, both under the card's new key and with the `tz`
 *    that v1 never wrote down made explicit (`fallbackTz`, the guess replay
 *    already makes for v1 lines). A hash no card has any more (a deck archived
 *    or deleted) keeps its v1 `h:` key.
 * 3. **Check** that replaying the new events lands every card where the state
 *    file says it was. See `checkMigration`.
 *
 * Everything lands in `reviews/<month>.v1.jsonl` on the data branch. `v1` is
 * a reserved writer name (`month-files.ts`): no device can be called that, so
 * no device will ever treat these files as its own and rebuild them.
 */

export { MIGRATED_DEVICE };

export const STATE_FILE = "hashcards-state.json";
export const V1_LOG_DIR = "hashcards-reviews";

/** One `hashcards-state.json` entry, as the v1 app wrote it. */
export type V1Entry = {
  lastReviewedAt: string;
  stability: number;
  difficulty: number;
  intervalRaw: number;
  intervalDays: number;
  dueDate: string;
  reviewCount: number;
};

export type MigrationInput = {
  /** Every deck file, as `{ path, text }`. */
  decks: { path: string; text: string }[];
  /** `hashcards-state.json`'s text; null when there is none. */
  state: string | null;
  /** Every `hashcards-reviews/*.jsonl`, as `{ path, text }`. */
  logs: { path: string; text: string }[];
};

export type ReviewSettings = { retention: number; fuzz: boolean };

/**
 * A setting as migration decided it: read off the state file when it says,
 * the default otherwise, and why.
 */
export type Inferred<T> = { value: T; source: "state file" | "default"; note: string };

export type Verdict =
  /** Same due date, stability, difficulty and review count. */
  | "exact"
  /** Same memory state; the due date moved, but within fuzz. */
  | "fuzz"
  /** The log has reviews after the state file's entry, and replay applied them. */
  | "newer"
  /** Scheduled at a different retention than the current one. */
  | "retention"
  /**
   * Scheduled under a v1 rule the scheduler has since dropped: the 256-day
   * cap, or a pass due the same day. The app already replays these cards
   * without it, before the migration as after.
   */
  | "rules"
  /** Anything else. A migration with any of these is refused. */
  | "other";

export type CheckRow = {
  /** The card's key after migration (`h:` for a card no deck has). */
  key: string;
  hash: string;
  /** Whether a deck still has the card. */
  known: boolean;
  before: { due: string; s: number; d: number; reps: number; at: string };
  after: { due: string; s: number; d: number; reps: number; at: string } | null;
  /** After minus before, in days; null when there is no after. */
  dueDelta: number | null;
  verdict: Verdict;
  why?: string;
};

export type MigrationPlan = {
  /** Files for the data branch, by path. */
  files: Map<string, string>;
  /** Every v1 hash a deck has, and the key(s) it now goes by. */
  keysByHash: Map<string, string[]>;
  counts: {
    cards: number;
    baselines: number;
    reviews: number;
    /** Hashes in the history that no deck has: kept under `h:` keys. */
    unknownHashes: number;
    unknownBaselines: number;
    unknownReviews: number;
  };
  settings: { retention: Inferred<number>; fuzz: Inferred<boolean> };
  check: CheckSummary;
  /** What `hc due` and the app show before the migration, against after. */
  dueShift: DueShift;
  /** Every event written, for replaying the result without reading it back. */
  events: ReviewLogEvent[];
  warnings: string[];
};

export type CheckSummary = { rows: CheckRow[] } & Record<Verdict, number>;

const V1_HASH = /^[0-9a-f]{64}$/;

const hashKey = (hash: string) => formatKey({ kind: "hash", hash });

// --- Reading v1 -------------------------------------------------------------

/** The state file's entries that are whole enough to migrate, and what is not. */
export function readStateFile(text: string | null): {
  entries: Map<string, V1Entry>;
  warnings: string[];
} {
  const entries = new Map<string, V1Entry>();
  const warnings: string[] = [];
  if (text === null) return { entries, warnings };
  let data: { cards?: Record<string, Partial<V1Entry>> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${STATE_FILE} is not valid JSON`);
  }
  for (const [hash, e] of Object.entries(data.cards ?? {})) {
    const ok =
      V1_HASH.test(hash) &&
      typeof e.lastReviewedAt === "string" &&
      Number.isFinite(Date.parse(e.lastReviewedAt)) &&
      typeof e.stability === "number" &&
      e.stability > 0 &&
      typeof e.difficulty === "number" &&
      e.difficulty >= 1 &&
      e.difficulty <= 10 &&
      Number.isInteger(e.reviewCount) &&
      typeof e.dueDate === "string";
    if (ok) entries.set(hash, e as V1Entry);
    // A migration must not lose a card quietly: an entry it cannot read is
    // reported, and the person decides whether that matters.
    else warnings.push(`${STATE_FILE}: entry ${hash.slice(0, 16)} is incomplete and was skipped`);
  }
  return { entries, warnings };
}

// --- Settings ---------------------------------------------------------------

/**
 * The retention a state-file entry was scheduled at, read back from its raw
 * interval: `interval(r, s)` solved for `r`. The v1 app wrote both, so this is
 * exact up to rounding, and it is the only record of the setting outside the
 * phone's own storage.
 */
export function impliedRetention(entry: V1Entry, params: readonly number[] = PARAMETERS): number {
  const decay = -params[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return Math.pow((entry.intervalRaw * factor) / entry.stability + 1, decay);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Collection settings for `hashcards.toml`, taken from the state file where it
 * shows them. Retention: what the most recently reviewed card was scheduled
 * at, which is the setting as it stands. Fuzz: on if any interval was moved
 * off its rounded value; off if enough were not that chance cannot explain it
 * (each is a one-in-three at best); otherwise the default.
 */
export function inferSettings(entries: Map<string, V1Entry>): {
  retention: Inferred<number>;
  fuzz: Inferred<boolean>;
} {
  const all = [...entries.values()].filter((e) => e.intervalRaw > 0);
  let retention: Inferred<number> = {
    value: DEFAULT_RETENTION,
    source: "default",
    note: "no state file entries to read it from",
  };
  if (all.length > 0) {
    const latest = all.reduce((a, b) => (b.lastReviewedAt > a.lastReviewedAt ? b : a));
    const r = round3(impliedRetention(latest));
    const agree = all.filter((e) => round3(impliedRetention(e)) === r).length;
    retention =
      r >= MIN_RETENTION && r <= MAX_RETENTION
        ? { value: r, source: "state file", note: `${agree} of ${all.length} cards were scheduled at it` }
        : {
            value: DEFAULT_RETENTION,
            source: "default",
            note: `the state file implies ${r}, outside ${MIN_RETENTION}–${MAX_RETENTION}`,
          };
  }

  // Cards with a rounded interval of 3 or more are the ones fuzz moves.
  const eligible = all.filter((e) => Math.round(e.intervalRaw) >= 3);
  const moved = eligible.filter((e) => e.intervalDays !== Math.round(e.intervalRaw)).length;
  const fuzz: Inferred<boolean> =
    moved > 0
      ? { value: true, source: "state file", note: `${moved} of ${eligible.length} intervals were fuzzed` }
      : eligible.length >= 5
        ? { value: false, source: "state file", note: `none of ${eligible.length} intervals were fuzzed` }
        : { value: true, source: "default", note: `only ${eligible.length} intervals long enough to tell` };
  return { retention, fuzz };
}

// --- The plan ---------------------------------------------------------------

export async function planMigration(
  input: MigrationInput,
  override: Partial<ReviewSettings> = {}
): Promise<MigrationPlan> {
  const warnings: string[] = [];

  // 1. Hashes to keys.
  const keysByHash = new Map<string, string[]>();
  /**
   * Key -> the key the app and `hc` replay the card under before migrating:
   * the same key, since both read a v1 collection's history under 1.0 keys
   * already. So fuzz, seeded by the key, moves nothing.
   */
  const previousKey = new Map<string, string>();
  let cards = 0;
  for (const deck of input.decks) {
    const name = deck.path.slice(deck.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    for (const card of await parseFile(deck.text, deck.path, name)) {
      previousKey.set(card.key, card.key);
      cards++;
      // The same text in two files is one card (§2.7), so one key.
      const keys = keysByHash.get(card.hash) ?? [];
      if (!keys.includes(card.key)) keys.push(card.key);
      keysByHash.set(card.hash, keys);
    }
  }

  // 2. History, re-keyed.
  const { entries, warnings: stateWarnings } = readStateFile(input.state);
  warnings.push(...stateWarnings);
  const keysOf = (card: string): string[] =>
    V1_HASH.test(card) ? (keysByHash.get(card) ?? [hashKey(card)]) : [card];

  const v1Reviews: ReviewEvent[] = [];
  for (const log of input.logs) {
    const { events, errors } = parseLog(log.text);
    for (const e of errors) warnings.push(`${log.path}:${e.line}: ${e.error}`);
    for (const e of events) {
      if (e.kind === "review") v1Reviews.push(e);
      else warnings.push(`${log.path}: a baseline in a v1 log, kept as it is`);
    }
  }

  const events: ReviewLogEvent[] = [];
  let reviews = 0;
  let unknownReviews = 0;
  const unknown = new Set<string>();
  const gradeAt = new Map<string, ReviewEvent["grade"]>();
  for (const e of v1Reviews) {
    gradeAt.set(`${e.card} ${e.at}`, e.grade);
    const known = keysByHash.has(e.card);
    if (!known && V1_HASH.test(e.card)) unknown.add(e.card);
    for (const card of keysOf(e.card)) {
      // No `src`: a device that made this review still holds its own copy,
      // keyed `h:` if the card has no ID yet, and would send the same line.
      // Byte-identical lines are one event to replay; a `src` here would make
      // that copy count twice for any card whose key did not change.
      const { src: _src, ...rest } = e;
      events.push({ ...rest, card });
      if (known) reviews++;
      else unknownReviews++;
    }
  }

  let baselines = 0;
  let unknownBaselines = 0;
  for (const [hash, entry] of entries) {
    const known = keysByHash.has(hash);
    if (!known) unknown.add(hash);
    // The grade of the review the entry was taken at, when the log has it:
    // the same-day rule needs to know whether it was a lapse.
    const grade = gradeAt.get(`${hash} ${entry.lastReviewedAt}`);
    for (const card of keysOf(hash)) {
      const baseline: BaselineEvent = {
        v: 2,
        kind: "baseline",
        card,
        at: entry.lastReviewedAt,
        tz: fallbackTz(entry.lastReviewedAt),
        s: entry.stability,
        d: entry.difficulty,
        reps: entry.reviewCount,
        ...(grade ? { grade } : {}),
        src: "v1",
      };
      events.push(baseline);
      if (known) baselines++;
      else unknownBaselines++;
    }
  }

  const files = monthFiles(events, MIGRATED_DEVICE);

  // 3. Settings and the check.
  const settings = inferSettings(entries);
  const options: ReviewSettings = {
    retention: override.retention ?? settings.retention.value,
    fuzz: override.fuzz ?? settings.fuzz.value,
  };
  const check = checkMigration(entries, v1Reviews, events, keysByHash, options);
  const dueShift = compareDue(events, previousKey, options);

  return {
    files,
    keysByHash,
    counts: {
      cards,
      baselines,
      reviews,
      unknownHashes: unknown.size,
      unknownBaselines,
      unknownReviews,
    },
    settings,
    check,
    dueShift,
    events,
    warnings,
  };
}

// --- What the app and `hc due` see ------------------------------------------

export type DueShift = {
  /** Cards with history (in a deck) that are due on the same day before and after. */
  same: number;
  moved: { key: string; before: string; after: string }[];
};

/**
 * Before the migration, the app and `hc due` already replay the v1 history
 * (the state file as baselines, the logs as reviews), under the keys cards
 * had then — `h:` for a card with no ID. After it, they replay the migrated
 * events under the new keys. The memory state is the same either way; only
 * fuzz, seeded by the key, can move a due date, and only within its window.
 * This says which cards it moved, so nobody is surprised by them.
 */
export function compareDue(
  events: readonly ReviewLogEvent[],
  previousKey: Map<string, string>,
  options: ReviewSettings
): DueShift {
  const after = replay(events, options);
  const before = replay(
    events.map((e) => ({ ...e, card: previousKey.get(e.card) ?? e.card })),
    options
  );
  const shift: DueShift = { same: 0, moved: [] };
  for (const [key, state] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    // Only cards a deck has: an `h:` key with no card is not shown anywhere,
    // and keeps its key, so it could not move.
    const old = previousKey.has(key) ? before.get(previousKey.get(key)!) : undefined;
    if (!old) continue;
    if (old.dueDate === state.dueDate) shift.same++;
    else shift.moved.push({ key, before: old.dueDate, after: state.dueDate });
  }
  return shift;
}

// --- The before/after check -------------------------------------------------

/**
 * The due dates fuzz could have given a card with this raw interval, as
 * `schedule` computes them: ±5% (at least a day) around the rounded interval
 * from 3 days up, and never under a day for a pass.
 */
export function fuzzWindow(intervalRaw: number, grade: number | null): [number, number] {
  const days = Math.round(intervalRaw);
  const delta = days < 3 ? 0 : Math.max(1, Math.round(days * 0.05));
  const floor = grade === FORGOT ? 0 : 1;
  return [Math.max(floor, days - delta), Math.max(floor, days + delta)];
}

/** The longest interval the v1 app would schedule. */
const V1_MAX_INTERVAL = 256;

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * Every state-file card, before (the state file) against after (a replay of
 * the migrated events at the collection's settings).
 *
 * Stability, difficulty and review count must match exactly: they come
 * straight from the baseline. The due date may not: v1 drew fuzz from
 * `Math.random`, replay seeds it from the card's key, and the key is new. So a
 * due date that moved is fine if the state file's date lies inside the window
 * fuzz could have put it in. Two explained exceptions: a card the log has
 * newer reviews of than the state file (replay applies them, as the app
 * already does for a v1 collection), and a card scheduled at another
 * retention (replay schedules every card at the current one, §2.6). Anything
 * else is a bug in the migration, and refuses `--apply`.
 */
export function checkMigration(
  entries: Map<string, V1Entry>,
  v1Reviews: readonly ReviewEvent[],
  events: readonly ReviewLogEvent[],
  keysByHash: Map<string, string[]>,
  options: ReviewSettings
): CheckSummary {
  const states = replay(events, options);
  const lastLogged = new Map<string, string>();
  for (const e of v1Reviews) {
    if ((lastLogged.get(e.card) ?? "") < e.at) lastLogged.set(e.card, e.at);
  }

  const rows: CheckRow[] = [];
  for (const [hash, entry] of entries) {
    const known = keysByHash.has(hash);
    for (const key of keysByHash.get(hash) ?? [hashKey(hash)]) {
      const state = states.get(key);
      rows.push(checkRow(key, hash, known, entry, state, lastLogged.get(hash), options.retention));
    }
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  const summary = { rows, exact: 0, fuzz: 0, newer: 0, retention: 0, rules: 0, other: 0 };
  for (const row of rows) summary[row.verdict]++;
  return summary;
}

function checkRow(
  key: string,
  hash: string,
  known: boolean,
  entry: V1Entry,
  state: CardState | undefined,
  lastLogged: string | undefined,
  retention: number
): CheckRow {
  const before = {
    due: entry.dueDate,
    s: entry.stability,
    d: entry.difficulty,
    reps: entry.reviewCount,
    at: entry.lastReviewedAt,
  };
  if (!state) {
    return { key, hash, known, before, after: null, dueDelta: null, verdict: "other", why: "no state after replay" };
  }
  const after = {
    due: state.dueDate,
    s: state.stability,
    d: state.difficulty,
    reps: state.reviewCount,
    at: state.lastReviewedAt,
  };
  const row = { key, hash, known, before, after, dueDelta: daysBetween(before.due, after.due) };

  if (lastLogged !== undefined && lastLogged > entry.lastReviewedAt) {
    return { ...row, verdict: "newer", why: `reviewed at ${lastLogged}, after the state file's entry` };
  }
  const memory =
    close(after.s, before.s) &&
    close(after.d, before.d) &&
    after.reps === before.reps &&
    after.at === before.at;
  if (!memory) return { ...row, verdict: "other", why: "stability, difficulty or review count changed" };
  if (after.due === before.due) return { ...row, verdict: "exact" };

  const lastDay = dayAt(entry.lastReviewedAt, fallbackTz(entry.lastReviewedAt));
  const v1Interval = daysBetween(lastDay, entry.dueDate);
  const [lo, hi] = fuzzWindow(state.intervalRaw, state.lastGrade);
  if (v1Interval >= lo && v1Interval <= hi) return { ...row, verdict: "fuzz" };

  // `src/core/schedule.ts` records both: intervals were capped at 256 days,
  // and a pass could round down to 0 and be due again the same day.
  if (v1Interval === V1_MAX_INTERVAL && lo > V1_MAX_INTERVAL) {
    return { ...row, verdict: "rules", why: `v1 capped the interval at ${V1_MAX_INTERVAL} days; now ${lo}–${hi}` };
  }
  if (v1Interval === 0 && lo >= 1) {
    return { ...row, verdict: "rules", why: "v1 let a pass be due the same day; now never" };
  }

  const scheduledAt = round3(impliedRetention(entry));
  if (scheduledAt !== round3(retention)) {
    // Replay schedules at today's retention; the state file at whatever it
    // was then. The interval it would have had now is what replay gave.
    const [lo2, hi2] = fuzzWindow(interval(scheduledAt, entry.stability), state.lastGrade);
    if (v1Interval >= lo2 && v1Interval <= hi2) {
      return { ...row, verdict: "retention", why: `scheduled at retention ${scheduledAt}, now ${retention}` };
    }
  }
  return {
    ...row,
    verdict: "other",
    why: `state file interval ${v1Interval} days, outside fuzz of ${lo}–${hi}`,
  };
}

// --- Removing IDs (PLAN-1.0 §2.7) -------------------------------------------

/**
 * Moving a collection off the `ID:` lines the first 1.0 builds wrote. Its
 * history is filed under ID keys (`est-capital`, `est-capital:r`, …); a card is
 * its text again, so each of those keys gets a `link` to the card's content
 * key, and the `ID:` lines come out of the files.
 *
 * History is never deleted, so keys no current card has (a card deleted, or
 * an archived deck, still under a v1 `h:` key) are looked up in earlier
 * versions of the deck files: a card found there is linked to the key its
 * text gives now, so re-adding it picks the history back up.
 */
export type IdRemovalInput = {
  decks: { path: string; text: string }[];
  /** Earlier versions of deck files, newest first: the first one found wins. */
  history: { path: string; text: string }[];
  /** Every event on the data branch, as written. */
  events: ReviewLogEvent[];
  /** When the links are dated. */
  at: string;
  tz: number;
};

export type IdRemovalPlan = {
  /** Decks whose `ID:` lines come out: their new text, and how many. */
  stripped: { path: string; text: string; ids: number }[];
  links: LinkEvent[];
  counts: {
    cards: number;
    /** Links for cards in the decks now. */
    current: number;
    /** Links found in earlier versions of the decks. */
    recovered: number;
    /** Keys with history that no link reaches and no card has. */
    orphans: number;
  };
  /**
   * Every card with history, before (what the app shows now, `ID:` lines read
   * as links) against after (the links written, the lines gone). Identical
   * unless something is wrong.
   */
  check: { same: number; changed: { key: string; before: string; after: string }[] };
};

const deckName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

async function tryParse(path: string, text: string): Promise<ParsedCard[] | null> {
  try {
    return await parseFile(text, path, deckName(path));
  } catch {
    return null;
  }
}

export async function planIdRemoval(
  input: IdRemovalInput,
  options: ReviewSettings
): Promise<IdRemovalPlan> {
  const link = (from: string, card: string): LinkEvent => ({
    v: 2,
    kind: "link",
    card,
    from,
    at: input.at,
    tz: input.tz,
    src: "migrate",
  });
  const withHistory = new Set(input.events.flatMap((e) => (e.kind === "link" ? [e.from] : [e.card])));

  const stripped: IdRemovalPlan["stripped"] = [];
  const current: ParsedCard[] = [];
  for (const deck of input.decks) {
    const cards = await parseFile(deck.text, deck.path, deckName(deck.path));
    current.push(...cards);
    const text = stripIds(deck.text, deck.path);
    if (text !== deck.text) {
      const ids = deck.text.split("\n").length - text.split("\n").length;
      stripped.push({ path: deck.path, text, ids });
    }
  }
  const inUse = new Set(current.map((c) => c.key));

  const links: LinkEvent[] = [];
  const linked = new Set<string>();
  const add = (from: string | null, to: string): boolean => {
    if (!from || from === to || inUse.has(from) || linked.has(from) || !withHistory.has(from)) return false;
    linked.add(from);
    links.push(link(from, to));
    return true;
  };
  let currentLinks = 0;
  for (const card of current) {
    for (const from of formerKeys(card)) if (add(from, card.key)) currentLinks++;
  }
  let recovered = 0;
  for (const old of input.history) {
    for (const card of (await tryParse(old.path, old.text)) ?? []) {
      if (add(card.legacyKey, card.key)) recovered++;
      if (add(hashKey(card.hash), card.key)) recovered++;
    }
  }

  // The check: replay as the app does now (every former key read as a link),
  // and as it will (the links written, the ID lines gone).
  const implicit = (cards: ParsedCard[]) =>
    cards.flatMap((c) => formerKeys(c).map((from) => ({ ...link(from, c.key), at: "1970-01-01T00:00:00.000Z" })));
  const before = replay([...input.events, ...implicit(current)], options);
  const after = replay(
    [...input.events, ...links, ...implicit(current.map((c) => ({ ...c, legacyKey: null })))],
    options
  );
  const check: IdRemovalPlan["check"] = { same: 0, changed: [] };
  const describe = (st: CardState | undefined) =>
    st ? `due ${st.dueDate}, s ${st.stability.toFixed(4)}, d ${st.difficulty.toFixed(4)}, reps ${st.reviewCount}` : "no history";
  for (const key of [...inUse].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    if (!a && !b) continue;
    if (describe(a) === describe(b)) check.same++;
    else check.changed.push({ key, before: describe(b), after: describe(a) });
  }

  const reached = new Set([...inUse, ...linked]);
  const orphans = [...withHistory].filter((k) => !reached.has(k) && !k.includes("/")).length;
  return {
    stripped,
    links,
    counts: { cards: current.length, current: currentLinks, recovered, orphans },
    check,
  };
}
