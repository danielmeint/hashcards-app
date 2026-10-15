import { formatKey } from "./card-key";
import { ReviewLogEvent } from "./core/events";
import { ReplayOptions, Replayed, replayAll, replayMore } from "./core/replay";
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
  return { groups, v1 };
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
