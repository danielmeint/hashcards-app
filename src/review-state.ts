import { formatKey, formerKeys } from "./card-key";
import { ReviewLogEvent, ScheduleEvent } from "./core/events";
import { ReplayOptions, Replayed, compareOrder, orderOf, replayAll, replayMore, resolveLinks } from "./core/replay";
import { dayAt } from "./core/schedule";
import {
  ReplayMark,
  StateRecord,
  clearReplay,
  getAllDeckFiles,
  getAllReviews,
  getLocalBaselines,
  getMeta,
  getPulledFiles,
  getStateRecords,
  groupOf,
  SUBSCRIBED_GROUP,
  replayMarkKey,
  stateKeyIn,
  writeReplay,
} from "./db";
import { reviewEvent } from "./review-log";
import { v1FilesKey } from "./v1-log";
import { settings } from "./settings";

/**
 * Where every card is: the review log replayed (PLAN-1.0 §2.6), cached.
 *
 * The events are this device's own (`reviews` and `baselines`) and everyone
 * else's as last pulled (`pulled`). They are replayed per group — each
 * collection's own cards, and subscribed cards together (see `groupOf` for why
 * not all at once) — and the result is written to the `states` store, where
 * the deck list and the drill read it.
 *
 * Incremental where it can be. A grade is applied to the cache as it happens
 * (`persistReview`), so a sync only has the events it just pulled to add, and
 * `replayMore` adds them on to the cache if they all come after what it has
 * already applied — the common case, another device's reviews from since we
 * last looked. Anything else (a late arrival, new settings, a group never
 * replayed here) replays the group from nothing, which is always correct.
 *
 * A collection still on v1 files is replayed whole every time: its events name
 * cards by content hash, and which key a hash is depends on the cards, which
 * can change under it. It is a transitional state, and small.
 */

/** Replay as the settings say now. FSRS parameters stay the defaults until M7. */
export function replayOptions(): ReplayOptions {
  return {
    retention: settings.desiredRetention.get(),
    fuzz: settings.intervalFuzz.get(),
  };
}

const V1_HASH = /^[0-9a-f]{64}$/;

/** When an implicit link from a key a card used to have is dated: before any real one. */
const LEGACY_LINK_AT = "1970-01-01T00:00:00.000Z";

/** Every event this device knows, by group, cards spelled as their logs spell them. */
export async function collectEvents(): Promise<{
  groups: Map<string, ReviewLogEvent[]>;
  /** Groups holding events read from v1 files, keyed by hash. */
  v1: Set<string>;
}> {
  const groups = new Map<string, ReviewLogEvent[]>();
  const v1 = new Set<string>();
  const add = (group: string, event: ReviewLogEvent) => {
    const list = groups.get(group);
    if (list) list.push(event);
    else groups.set(group, [event]);
  };

  const migrated = new Map<string, boolean>();
  const isMigrated = async (repo: string) => {
    if (!migrated.has(repo)) {
      const files = await getMeta<unknown[]>(v1FilesKey(repo));
      migrated.set(repo, files !== undefined && files.length === 0);
    }
    return migrated.get(repo)!;
  };
  for (const review of await getAllReviews()) {
    // A review this device wrote to a v1 log is, once the collection has been
    // migrated, on the data branch already — under the card's new key, where
    // this copy still has the old `h:` one. Replaying both would leave the
    // card a second, orphaned schedule. The migrated copy is the one to keep.
    if (review.v1Pushed && (await isMigrated(review.log))) continue;
    const event = reviewEvent(review);
    add(groupOf(review.log, event.card), event);
  }
  for (const { log, event } of await getLocalBaselines()) {
    add(groupOf(log, event.card), event);
  }

  const pulled = await getPulledFiles();
  const hashKeys = pulled.some((f) => f.events.some((e) => V1_HASH.test(e.card)))
    ? await keysByHash()
    : new Map<string, Map<string, string>>();
  for (const file of pulled) {
    for (const event of file.events) {
      if (V1_HASH.test(event.card)) {
        const card =
          hashKeys.get(file.repo)?.get(event.card) ??
          formatKey({ kind: "hash", hash: event.card });
        const group = groupOf(file.repo, card);
        v1.add(group);
        add(group, { ...event, card });
      } else {
        add(groupOf(file.repo, event.card), event);
      }
    }
  }

  // A card may have history under keys it no longer has (PLAN-1.0 §2.7):
  // the key its `ID:` line gave it, while files had them, and the `h:` key
  // of its v1 hash, which is what it was before 1.0. Until `hc migrate`
  // writes links for real, those are links — dated at the epoch, so any real
  // link wins.
  for (const file of await getAllDeckFiles()) {
    for (const card of file.cards) {
      for (const from of formerKeys(card)) {
        const link = (group: string, prefix: string): void =>
          add(group, { v: 2, kind: "link", card: prefix + card.key, from: prefix + from, at: LEGACY_LINK_AT });
        // Your own cards are in their collection's log, bare; a subscribed
        // collection's are in yours, qualified with its repo.
        if (groups.has(file.repo)) link(file.repo, "");
        if (groups.has(SUBSCRIBED_GROUP)) link(SUBSCRIBED_GROUP, `${file.repo}/`);
      }
    }
  }
  return { groups, v1 };
}

/** One grade from the log, wherever it was given. */
export type HistoryEntry = {
  key: string;
  reviewedAt: string;
  /** The local day it was given on, in the timezone it was recorded in. */
  day: string;
  grade: 1 | 2 | 3 | 4;
};

/**
 * Every grade in the log — this device's and every other device's, as pulled
 * — keyed as the app keys cards (`owner/repo/<key>`), links resolved. Baselines
 * are left out: they stand for history, they are not grades anyone gave. The
 * same grade read twice (two copies of one line) counts once, as in replay.
 */
export async function reviewHistory(): Promise<HistoryEntry[]> {
  const { groups } = await collectEvents();
  const history: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const [group, events] of groups) {
    for (const event of resolveLinks(events)) {
      if (event.kind !== "review") continue;
      const key = stateKeyIn(group, event.card);
      const id = `${key}\u0000${event.at}\u0000${event.grade}`;
      if (seen.has(id)) continue;
      seen.add(id);
      history.push({ key, reviewedAt: event.at, day: dayAt(event.at, event.tz), grade: event.grade });
    }
  }
  return history;
}

/**
 * The cards first graded on `day`, on any device: those whose earliest event is
 * a review given that day, in the timezone it was given in. A card whose
 * history starts with a baseline (migrated, imported) was not new.
 *
 * What the new-card budget is spent against (`new-card-budget.ts`), as `hc due`
 * counts it (`introducedOn`): one budget, so one count, whichever device the
 * cards were started on.
 */
export async function startedOn(day: string): Promise<Set<string>> {
  const { groups } = await collectEvents();
  const started = new Set<string>();
  for (const [group, events] of groups) {
    const first = new Map<string, ScheduleEvent>();
    for (const event of resolveLinks(events)) {
      const seen = first.get(event.card);
      if (!seen || compareOrder(orderOf(event), orderOf(seen)) < 0) first.set(event.card, event);
    }
    for (const [card, event] of first) {
      if (event.kind === "review" && dayAt(event.at, event.tz) === day) {
        started.add(stateKeyIn(group, card));
      }
    }
  }
  return started;
}

/** Per collection, the key each v1 content hash now belongs to. */
async function keysByHash(): Promise<Map<string, Map<string, string>>> {
  const byRepo = new Map<string, Map<string, string>>();
  for (const file of await getAllDeckFiles()) {
    let keys = byRepo.get(file.repo);
    if (!keys) byRepo.set(file.repo, (keys = new Map()));
    for (const card of file.cards) {
      keys.set(card.hash, card.key || formatKey({ kind: "hash", hash: card.hash }));
    }
  }
  return byRepo;
}

/**
 * Bring the cache up to date with every event known here. `fresh` is what a
 * pull just added, by group: the only events an up-to-date group has not seen.
 * With nothing fresh, a group is only replayed if its cache cannot be trusted —
 * which is how a change of desired retention reaches every due date.
 */
export async function refreshStates(
  fresh: Map<string, ReviewLogEvent[]> = new Map()
): Promise<void> {
  const options = replayOptions();
  const { groups, v1 } = await collectEvents();
  const records = await getStateRecords();

  for (const [group, all] of groups) {
    const mark = await getMeta<ReplayMark>(replayMarkKey(group));
    let result: Replayed;
    if (!mark || mark.stale || v1.has(group)) {
      result = replayAll(all, options);
    } else {
      const prev: Replayed = {
        cards: new Map(
          records.filter((r) => r.group === group).map((r) => [r.card, r])
        ),
        watermark: mark.watermark,
        options: mark.options,
      };
      const more = replayMore(prev, fresh.get(group) ?? [], () => all, options);
      if (!more.replayedAll && more.watermark === mark.watermark) continue;
      result = more;
    }
    await writeReplay(
      group,
      [...result.cards].map(([card, state]): StateRecord => ({
        ...state,
        key: stateKeyIn(group, card),
        group,
        card,
      })),
      { watermark: result.watermark, options: result.options }
    );
  }

  // A group whose events have all gone — a collection removed, a lone review
  // undone — must not leave its cards scheduled.
  const stale = new Set(
    records.map((r) => r.group).filter((g) => g !== "seed" && !groups.has(g))
  );
  for (const group of stale) await clearReplay(group);
}
