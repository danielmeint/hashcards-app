import { LinkEvent, ReviewLogEvent, ScheduleEvent, fallbackTz, serializeEvent } from "./events";
import {
  DEFAULT_RETENTION,
  GradeValue,
  PARAMETERS,
  dayAt,
  schedule,
  step,
} from "./schedule";

/**
 * A card's state is a pure function of the review log:
 *
 *     replay(events, { params, retention, fuzz }) → Map<key, CardState>
 *
 * Same events in, same states out, on every device and in any order the
 * events arrive. That is what lets the log be the only thing that syncs: two
 * phones that have pulled the same files agree on every due date without ever
 * exchanging a state.
 *
 * Three things make it so. Events are put in one total order before anything
 * is computed (`compareEvents`). Days are counted in the timezone recorded
 * with each review, never the replaying device's (`dayAt`). And fuzz is seeded
 * from the card and its review count, not drawn at random (`fuzzSeed`).
 *
 * The step itself is `src/core/schedule.ts`, the same one the live path uses,
 * so replaying what the app just did gives what the app just computed.
 */

/**
 * Where a card is after its events. The same fields as a `ReviewedPerformance`
 * (`src/types.ts`), so the app can use it as one, plus what replay needs to
 * carry on from it.
 */
export type CardState = {
  type: "reviewed";
  lastReviewedAt: string;
  stability: number;
  difficulty: number;
  intervalRaw: number;
  intervalDays: number;
  dueDate: string;
  reviewCount: number;
  /** The local day of the last review, in the timezone it was recorded in. */
  lastDay: string;
  /** The last review's grade; null after a baseline that did not record one. */
  lastGrade: GradeValue | null;
};

export type ReplayOptions = {
  /** FSRS weights; the published FSRS-6 defaults when absent. */
  params?: readonly number[];
  /**
   * Desired retention *now*. Every due date is the last review plus the
   * interval at this retention, so changing the setting moves every card at
   * once — the honest reading of it — rather than only cards reviewed since.
   */
  retention?: number;
  fuzz: boolean;
};

/**
 * Where an event falls in the one order replay applies them in.
 *
 * By instant first. Then, for events at the same instant: reviews before
 * baselines, because a baseline is the state *after* the review it was taken
 * at — migration writes one at a card's `lastReviewedAt`, which the v1 log
 * also has as a review — so it must win. Then by card, which only makes the
 * order total (different cards do not interact). Then by the serialised line,
 * which settles the last case, two devices grading one card in the same
 * millisecond, the same way everywhere. Identical lines are the same event,
 * and are applied once.
 */
export type EventOrder = {
  ms: number;
  rank: 0 | 1;
  card: string;
  line: string;
};

export function orderOf(event: ScheduleEvent): EventOrder {
  return {
    ms: Date.parse(event.at),
    rank: event.kind === "baseline" ? 1 : 0,
    card: event.card,
    line: serializeEvent(event),
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareOrder(a: EventOrder, b: EventOrder): number {
  return a.ms - b.ms || a.rank - b.rank || cmp(a.card, b.card) || cmp(a.line, b.line);
}

export function compareEvents(a: ReviewLogEvent, b: ReviewLogEvent): number {
  // Links sort among events like reviews do: by instant, then by line.
  const of = (e: ReviewLogEvent): EventOrder =>
    e.kind === "link" ? { ms: Date.parse(e.at), rank: 0, card: e.card, line: serializeEvent(e) } : orderOf(e);
  return compareOrder(of(a), of(b));
}

// --- Links (PLAN-1.0 §2.7) ---------------------------------------------------

/**
 * Where each linked key's history goes: `from` → the key it ends up as,
 * following chains (`a→b`, `b→c` sends `a` to `c`).
 *
 * Links are applied in time order, and a later link for the same `from` wins.
 * One that would close a cycle — `a→b`, then `b→a`, a relink undone — replaces
 * the older link of the cycle, so the history goes where the latest link says.
 */
export function linkMap(events: Iterable<ReviewLogEvent>): Map<string, string> {
  const links = [...events].filter((e): e is LinkEvent => e.kind === "link").sort(compareEvents);
  const next = new Map<string, string>();
  for (const { from, card } of links) {
    // Walk on from the new target; if the walk comes back to `from`, cut the
    // edge that does it.
    const seen = new Set<string>();
    for (let at = card; next.has(at) && !seen.has(at); at = next.get(at)!) {
      seen.add(at);
      if (next.get(at) === from) {
        next.delete(at);
        break;
      }
    }
    next.set(from, card);
  }
  const resolved = new Map<string, string>();
  for (const from of next.keys()) {
    let at = from;
    const seen = new Set<string>([at]);
    while (next.has(at) && !seen.has(next.get(at)!)) {
      at = next.get(at)!;
      seen.add(at);
    }
    resolved.set(from, at);
  }
  return resolved;
}

/**
 * The events that schedule, each under the key its card has now: links
 * applied (`linkMap`) and left out. What every reader of the log replays or
 * counts, so that a card's history is the same wherever it is read.
 */
export function resolveLinks(
  events: Iterable<ReviewLogEvent>,
  links: Map<string, string> = linkMap(events)
): ScheduleEvent[] {
  const out: ScheduleEvent[] = [];
  for (const event of events) {
    if (event.kind === "link") continue;
    const card = links.get(event.card);
    out.push(card === undefined ? event : { ...event, card });
  }
  return out;
}

/** Sort into replay order, dropping exact duplicates. Leaves `events` alone. */
function ordered(events: Iterable<ScheduleEvent>): { event: ScheduleEvent; order: EventOrder }[] {
  const all = [...events].map((event) => ({ event, order: orderOf(event) }));
  all.sort((a, b) => compareOrder(a.order, b.order));
  return all.filter((e, i) => i === 0 || e.order.line !== all[i - 1].order.line);
}

/**
 * One event applied to a card's state. Never mutates `prior`.
 *
 * Exported for the live path: a grade in the app is applied to the cached
 * state with exactly this, so what the drill shows is what a replay of the log
 * later computes — the same key seeding fuzz, the same recorded `tz` counting
 * days.
 */
export function applyEvent(
  prior: CardState | undefined,
  event: ScheduleEvent,
  options: ReplayOptions
): CardState {
  const retention = options.retention ?? DEFAULT_RETENTION;
  const params = options.params ?? PARAMETERS;
  const stepOptions = { retention, params, fuzz: options.fuzz, key: event.card };

  if (event.kind === "baseline") {
    // A reset, not a step: whatever came before is replaced by what the
    // baseline says, and the next review counts its gap from here.
    const lastDay = dayAt(event.at, event.tz ?? fallbackTz(event.at));
    const lastGrade = event.grade ?? null;
    return {
      type: "reviewed",
      lastReviewedAt: event.at,
      stability: event.s,
      difficulty: event.d,
      reviewCount: event.reps,
      lastDay,
      lastGrade,
      ...schedule(event.s, lastGrade, lastDay, event.reps, stepOptions),
    };
  }

  const today = dayAt(event.at, event.tz);
  const next = step(prior ?? null, event.grade, today, stepOptions);
  return {
    type: "reviewed",
    lastReviewedAt: event.at,
    stability: next.stability,
    difficulty: next.difficulty,
    intervalRaw: next.intervalRaw,
    intervalDays: next.intervalDays,
    dueDate: next.dueDate,
    reviewCount: next.reviewCount,
    lastDay: today,
    lastGrade: event.grade,
  };
}

/**
 * A replay's result together with what it takes to continue it: the last event
 * applied, and the options it was computed under. Plain data (a `Map` and
 * objects), so it can be cached in IndexedDB as it is.
 */
export type Replayed = {
  cards: Map<string, CardState>;
  /** The last event applied, in replay order; null if there were none. */
  watermark: EventOrder | null;
  /** The options the states were computed under. */
  options: string;
};

export function fingerprint({ params, retention, fuzz }: ReplayOptions): string {
  return JSON.stringify([
    [...(params ?? PARAMETERS)],
    retention ?? DEFAULT_RETENTION,
    fuzz,
  ]);
}

/** Every event, from nothing, links resolved. */
export function replayAll(
  events: Iterable<ReviewLogEvent>,
  options: ReplayOptions
): Replayed {
  const cards = new Map<string, CardState>();
  let watermark: EventOrder | null = null;
  for (const { event, order } of ordered(resolveLinks([...events]))) {
    cards.set(event.card, applyEvent(cards.get(event.card), event, options));
    watermark = order;
  }
  return { cards, watermark, options: fingerprint(options) };
}

/** The states of every card the events mention, keyed by card. */
export function replay(
  events: Iterable<ReviewLogEvent>,
  options: ReplayOptions
): Map<string, CardState> {
  return replayAll(events, options).cards;
}

/**
 * Carry `prev` on with events it has not seen, giving exactly what
 * `replayAll` over everything would.
 *
 * That holds only when every new event comes after the last one `prev`
 * applied. Devices sync when they sync, so a phone that was offline for a week
 * will deliver last week's reviews after today's have been replayed; and
 * different options mean every state is computed differently. Either way the
 * shortcut is not valid, and this replays `all()` — every event, old and new —
 * from nothing instead. `all` is a function so that the full log is only read
 * when it is needed.
 *
 * An event identical to the watermark is one already applied (a file read
 * twice), and is skipped rather than forcing a full replay.
 *
 * A new link renames history that is already applied, so it always forces a
 * full replay. Other new events are resolved through the links already in
 * `all()`: a review of a card's old key, from a device that had not heard of
 * the edit yet, lands on the new one.
 */
export function replayMore(
  prev: Replayed,
  newEvents: Iterable<ReviewLogEvent>,
  all: () => Iterable<ReviewLogEvent>,
  options: ReplayOptions
): Replayed & { replayedAll: boolean } {
  const incoming = [...newEvents];
  if (incoming.some((e) => e.kind === "link")) {
    return { ...replayAll(all(), options), replayedAll: true };
  }
  const links = linkMap(all());
  const fresh = ordered(links.size === 0 ? (incoming as ScheduleEvent[]) : resolveLinks(incoming, links)).filter(
    ({ order }) => prev.watermark === null || order.line !== prev.watermark.line
  );
  const inOrder =
    fingerprint(options) === prev.options &&
    (prev.watermark === null ||
      fresh.length === 0 ||
      compareOrder(fresh[0].order, prev.watermark) > 0);
  if (!inOrder) return { ...replayAll(all(), options), replayedAll: true };

  const cards = new Map(prev.cards);
  let watermark = prev.watermark;
  for (const { event, order } of fresh) {
    cards.set(event.card, applyEvent(cards.get(event.card), event, options));
    watermark = order;
  }
  return { cards, watermark, options: prev.options, replayedAll: false };
}
