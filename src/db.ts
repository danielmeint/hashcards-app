import { openDB, IDBPDatabase } from "idb";
import { utcOffsetMinutes } from "./core/schedule";
import { legacy, settings } from "./settings";
import { Card, DrillSession, ParsedCard, ReviewedPerformance, Review } from "./types";
import { formatKey, keyInLog, stateKey } from "./card-key";
import { BaselineEvent, ReviewLogEvent } from "./core/events";
import { CardState, EventOrder } from "./core/replay";
import { localDay } from "./fsrs";
import { logLine, v1MonthOf, v1PushedKey } from "./v1-log";
import { databaseName } from "./demo-mode";

const DB_VERSION = 8;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    // Named by `demo-mode.ts`: the real database, or the demo's own.
    dbPromise = openDB(databaseName(), DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains("performances")) {
          db.createObjectStore("performances", { keyPath: "hash" });
        }
        if (!db.objectStoreNames.contains("reviews")) {
          db.createObjectStore("reviews", { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("session")) {
          db.createObjectStore("session");
        }
        if (!db.objectStoreNames.contains("decks")) {
          migrateCardsFromLocalStorage(
            db.createObjectStore("decks", { keyPath: "path" })
          );
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
        if (!db.objectStoreNames.contains("credentials")) {
          db.createObjectStore("credentials");
        }
        if (!db.objectStoreNames.contains("origins")) {
          db.createObjectStore("origins");
        }
        // Keyed by repository *and* path: two collections can each hold an
        // `Algebra.md`, and with `path` alone the second silently replaced the
        // first. A new store rather than a re-keyed one because a keyPath
        // cannot be changed in place — the old one is emptied once its
        // contents have been carried across.
        if (!db.objectStoreNames.contains("deckFiles")) {
          db.createObjectStore("deckFiles", { keyPath: ["repo", "path"] });
        }
        // The images and audio cards reference, keyed like the deck files they
        // sit beside. Bytes rather than a Blob: a Blob in IndexedDB is not
        // something every browser (or test double) has always round-tripped.
        if (!db.objectStoreNames.contains("media")) {
          db.createObjectStore("media", { keyPath: ["repo", "path"] });
          // Media is fetched by a sync that finds the tree changed. A device
          // already up to date would get a 304 and never fetch the images its
          // cards already have, so the recorded tree tags go: one full listing
          // per collection, and the deck files themselves still match by SHA.
          if (oldVersion > 0 && db.objectStoreNames.contains("meta")) {
            tx.objectStore("meta").delete(
              IDBKeyRange.bound("tree_etag:", "tree_etag:\uffff")
            );
          }
        }
        // M3: the review log is the truth and state is replayed from it.
        // `states` is that replay's cache, keyed by card key rather than
        // hash; `pulled` holds the events read from other devices' files;
        // `baselines` the few baseline events this device writes itself. The
        // old `performances` store is carried across after opening and left
        // empty (see `migrateToKeys`).
        if (!db.objectStoreNames.contains("states")) {
          db.createObjectStore("states", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("pulled")) {
          db.createObjectStore("pulled", { keyPath: ["repo", "path"] });
        }
        if (!db.objectStoreNames.contains("baselines")) {
          db.createObjectStore("baselines", { autoIncrement: true });
        }
      },
    }).then(async (db) => {
      // Only once the cards are provably here, so a failed migration cannot
      // take the last copy with it.
      if (
        legacy.cards.get() !== null &&
        (await db.count("decks")) > 0
      ) {
        legacy.cards.remove();
      }
      await seedOrigins(db);
      await migrateDeckFiles(db);
      await migrateToKeys(db);
      return db;
    });
  }
  return dbPromise;
}

/**
 * Carry the old deck store into the one keyed by collection.
 *
 * The `decks` store was keyed by path alone, which could only ever describe one
 * repository — so everything in it belongs to the one that was configured. Done
 * after opening rather than in the upgrade, because a keyPath cannot be changed
 * in place and copying between two stores is ordinary work.
 */
async function migrateDeckFiles(db: IDBPDatabase): Promise<void> {
  if (!db.objectStoreNames.contains("decks")) return;

  // Emptying it is what records that this is done — there is no other writer,
  // so an empty old store means it has already been carried across, and
  // re-running would resurrect files the user has since removed.
  const old = await db.getAll("decks");
  if (old.length === 0) return;

  // Without a configured repository there is nothing to attribute these to.
  // Left where they are rather than dropped, so a launch that has one can
  // still carry them: this is the last copy of those cards until a sync.
  const owner = legacy.owner.get();
  const repo = legacy.repo.get();
  if (!owner || !repo) return;

  const key = `${owner}/${repo}`;
  const tx = db.transaction("deckFiles", "readwrite");
  for (const file of old as Omit<DeckFile, "repo">[]) {
    // The cards inside too, not only the file around them — they predate
    // knowing which collection they came from just as much as it does.
    tx.store.put({ ...file, repo: key, cards: inRepo(file.cards, key) });
  }
  await tx.done;
  await db.clear("decks");
}

/**
 * Which collection each card was last seen in, so a repository's state file can
 * hold its own cards and nobody else's.
 *
 * Existing scheduling predates the question, so there is no honest answer for
 * it in the data — but there is one outside it: everything already here was
 * synced from the repository currently configured, because until now the app
 * could only hold one at a time. Seeding from that keeps orphans attached to
 * the repo they came from. Without it, the first sync after this upgrade would
 * write a state file with every temporarily-absent card missing from it, and
 * every one of them would come back new.
 */
async function seedOrigins(db: IDBPDatabase): Promise<void> {
  // The legacy keys on purpose: a database that predates the origins store also
  // predates the repository list, so what it synced from is what was in these.
  const owner = legacy.owner.get();
  const repo = legacy.repo.get();
  if (!owner || !repo) return;
  // Only for a database that predates the question. Once anything is in here,
  // the answers are real ones and must not be overwritten with a guess.
  if ((await db.count("origins")) > 0) return;

  const hashes = await db.getAllKeys("performances");
  if (hashes.length === 0) return;
  const tx = db.transaction("origins", "readwrite");
  for (const hash of hashes) tx.store.put(`${owner}/${repo}`, String(hash));
  await tx.done;
}

/**
 * Cards used to live in a single localStorage blob — a 5 MB ceiling and a
 * synchronous parse on the startup path. Carry whatever is there into the new
 * store so the app still works offline immediately after upgrading. There are
 * no blob SHAs to recover, so every file reads as stale and the next sync while
 * online refetches all of them exactly once.
 */
function migrateCardsFromLocalStorage(store: {
  put: (value: DeckFile) => unknown;
}): void {
  const stored = legacy.cards.get();
  const owner = legacy.owner.get();
  const repo = legacy.repo.get();
  // Cards with no collection to belong to cannot be stored any more; anything
  // old enough to be in this blob was synced from the single configured repo,
  // and without one there is nothing to attribute them to.
  if (!stored || !owner || !repo) return;
  try {
    const byPath = new Map<string, Card[]>();
    for (const card of JSON.parse(stored) as Card[]) {
      const cards = byPath.get(card.filePath) ?? [];
      cards.push(card);
      byPath.set(card.filePath, cards);
    }
    for (const [path, cards] of byPath) {
      store.put({ repo: `${owner}/${repo}`, path, sha: "", cards });
    }
  } catch (e) {
    console.warn("Could not migrate cached cards:", e);
  }
}

// --- Keys --------------------------------------------------------------------

export { stateKey };

/**
 * Which replay a card's events belong to, and what that replay calls it.
 *
 * Replay seeds fuzz from the key *as the log spells it* — that is what makes
 * `hc` and every device agree on a due date. Your own cards are spelled bare in
 * their collection's log, so each collection is replayed on its own (two can
 * each have an `est-capital`). Subscribed cards are spelled `owner/repo/<key>`
 * wherever they are logged, so they share one replay, `"*"`.
 */
export const SUBSCRIBED_GROUP = "*";

export function groupOf(log: string, card: string): string {
  return log === "" || card.includes("/") ? SUBSCRIBED_GROUP : log;
}

export function stateKeyIn(group: string, card: string): string {
  return group === SUBSCRIBED_GROUP ? card : `${group}/${card}`;
}

// --- Derived state -------------------------------------------------------------

/**
 * One card's replayed state, as cached. `group` and `card` say where it came
 * from (see `groupOf`), so a replay of one group can replace its own records
 * and nobody else's.
 */
export type StateRecord = CardState & { key: string; group: string; card: string };

/** How far a group's cached replay has got, and under which options. */
export type ReplayMark = {
  watermark: EventOrder | null;
  options: string;
  /**
   * The cache is known not to be what a replay would give — a grade landed
   * before the watermark (a clock running behind another device's). The next
   * refresh replays the group from nothing.
   */
  stale?: boolean;
};

export const replayMarkKey = (group: string) => `replay:${group}`;

/** Every card that has been reviewed, by `stateKey`. */
export async function getAllPerformances(): Promise<Map<string, CardState>> {
  const db = await getDb();
  const all = (await db.getAll("states")) as StateRecord[];
  return new Map(all.map((record) => [record.key, record]));
}

export async function getStateRecords(): Promise<StateRecord[]> {
  const db = await getDb();
  return db.getAll("states");
}

/**
 * Replace what one group's replay left in the cache, and record how far it got.
 * One transaction: a cache whose mark says it is further on than its records
 * are would be skipped over by every later incremental replay.
 */
export async function writeReplay(
  group: string,
  records: StateRecord[],
  mark: ReplayMark
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["states", "meta"], "readwrite");
  const states = tx.objectStore("states");
  for (const old of (await states.getAll()) as StateRecord[]) {
    if (old.group === group) states.delete(old.key);
  }
  for (const record of records) states.put(record);
  tx.objectStore("meta").put(mark, replayMarkKey(group));
  await tx.done;
}

/** Drop a group that no longer has any events at all. */
export async function clearReplay(group: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["states", "meta"], "readwrite");
  const states = tx.objectStore("states");
  for (const old of (await states.getAll()) as StateRecord[]) {
    if (old.group === group) states.delete(old.key);
  }
  tx.objectStore("meta").delete(replayMarkKey(group));
  await tx.done;
}

/**
 * Put states straight into the cache, as if a replay had produced them. For
 * tests and fixtures that need a card to be somewhere in its schedule without
 * writing the history that would put it there; a refresh replaces them with
 * what the events say. Keys are `stateKey`s.
 */
export async function importState(
  states: Record<string, ReviewedPerformance>
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("states", "readwrite");
  for (const [key, perf] of Object.entries(states)) {
    tx.store.put(seedRecord(key, perf));
  }
  await tx.done;
}

/** A `StateRecord` for a state that did not come out of replay. */
function seedRecord(key: string, perf: ReviewedPerformance): StateRecord {
  return {
    type: "reviewed",
    lastReviewedAt: perf.lastReviewedAt,
    stability: perf.stability,
    difficulty: perf.difficulty,
    intervalRaw: perf.intervalRaw,
    intervalDays: perf.intervalDays,
    dueDate: perf.dueDate,
    reviewCount: perf.reviewCount,
    lastDay: localDay(new Date(perf.lastReviewedAt)),
    lastGrade: null,
    key,
    group: "seed",
    card: key,
  };
}

// --- Local events ----------------------------------------------------------------

/** A baseline this device wrote, and which collection's log it goes in. */
export type LocalBaseline = { log: string; event: BaselineEvent };

export async function getLocalBaselines(): Promise<LocalBaseline[]> {
  const db = await getDb();
  return db.getAll("baselines");
}

/**
 * Record baselines — a card's state carried onto a key it did not have before
 * (an edit of a card with no ID). Appended like reviews, never edited.
 */
export async function addBaselines(baselines: LocalBaseline[]): Promise<void> {
  if (baselines.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("baselines", "readwrite");
  for (const baseline of baselines) tx.store.add(baseline);
  await tx.done;
}

/** Mark reviews as written to a v1 log file (see `Review.v1Pushed`). */
export async function markV1Pushed(reviews: Review[]): Promise<void> {
  const wanted = new Set(reviews.map((r) => `${r.key}\u0000${r.reviewedAt}`));
  if (wanted.size === 0) return;
  const db = await getDb();
  const tx = db.transaction("reviews", "readwrite");
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const review = cursor.value as Review;
    if (!review.v1Pushed && wanted.has(`${review.key}\u0000${review.reviewedAt}`)) {
      cursor.update({ ...review, v1Pushed: true });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

// --- Pulled events -----------------------------------------------------------------

/**
 * One file of someone else's events, read from a collection: another device's
 * month file on the data branch, or for a collection not migrated yet its v1
 * log files and state file. Kept with the blob SHA it was read from, so the
 * next sync fetches only files that changed.
 *
 * `events` are as the file has them. A v1 file names cards by content hash;
 * which key that is depends on the cards, which change, so it is mapped when
 * the events are replayed rather than stored mapped.
 */
export type PulledFile = {
  /** `owner/repo` of the collection it was read from — its log. */
  repo: string;
  path: string;
  sha: string;
  events: ReviewLogEvent[];
};

export async function getPulledFiles(repo?: string): Promise<PulledFile[]> {
  const db = await getDb();
  const all = (await db.getAll("pulled")) as PulledFile[];
  return repo === undefined ? all : all.filter((f) => f.repo === repo);
}

export async function updatePulledFiles(
  updated: PulledFile[],
  removed: { repo: string; path: string }[] = []
): Promise<void> {
  if (updated.length === 0 && removed.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("pulled", "readwrite");
  for (const file of updated) tx.store.put(file);
  for (const { repo, path } of removed) tx.store.delete([repo, path]);
  await tx.done;
}

// --- Carrying a v7 database across to keys ---------------------------------------

/**
 * Move everything keyed by content hash onto card keys, once.
 *
 * Done after opening rather than in the upgrade: it needs the cached cards to
 * map hashes to keys, and the work is ordinary reads and writes. A meta flag
 * rather than "is `performances` empty" records that it ran, because an
 * install with no reviews yet still needs its deck files re-read.
 *
 * - **Deck files.** Cards cached before M1 have no `id`, `key`, `tags` or
 *   `status`. They get the values a card without an ID has (so the app works
 *   offline straight away), and their SHA is cleared so the next sync fetches
 *   and parses every file again — a file that did have `ID:` lines needs the
 *   new parser to see them.
 * - **Reviews** gain their key, the log they go to, and a `tz` (this device's
 *   offset at the time: they were taken here). Those already in a v1 log file
 *   are marked so, and are never pushed to the data branch a second time.
 * - **Performances** become baseline events and seed the state cache. Most are
 *   in a state file somewhere already; a subscribed card's are not — v1 kept
 *   them only on the device — and this is how they reach your data branch.
 * - **An interrupted drill** has its queue mapped across.
 */
async function migrateToKeys(db: IDBPDatabase): Promise<void> {
  if (await db.get("meta", "keys_migrated")) return;

  const files = (await db.getAll("deckFiles")) as DeckFile[];
  const byHash = new Map<string, Card>();
  const stale: DeckFile[] = [];
  for (const file of files) {
    if (file.cards.every((card) => typeof card.key === "string" && card.key !== "")) {
      for (const card of file.cards) byHash.set(card.hash, card);
      continue;
    }
    const cards = file.cards.map((card) => ({
      ...card,
      id: card.id ?? null,
      key: card.key || formatKey({ kind: "hash", hash: card.hash }),
      tags: card.tags ?? [],
      status: card.status ?? ("active" as const),
    }));
    for (const card of cards) byHash.set(card.hash, card);
    stale.push({ ...file, sha: "", cards });
  }

  const origins = new Map<string, string>();
  {
    const tx = db.transaction("origins");
    const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
    keys.forEach((key, i) => origins.set(String(key), values[i] as string));
  }
  const repos = settings.repos.get();
  const owner = legacy.owner.get();
  const name = legacy.repo.get();
  const writable = repos.filter((r) => !r.readOnly).map((r) => `${r.owner}/${r.repo}`);
  const fallbackRepo = writable[0] ?? (owner && name ? `${owner}/${name}` : "");
  const readOnly = new Set(repos.filter((r) => r.readOnly).map((r) => `${r.owner}/${r.repo}`));

  /** Where a v1 hash's history lives now. */
  const locate = (hash: string) => {
    const card = byHash.get(hash);
    const repo = card?.repo || origins.get(hash) || fallbackRepo;
    const key = stateKey({ repo, key: card?.key ?? "", hash });
    const log = repo !== "" && !readOnly.has(repo) ? repo : writable[0] ?? "";
    return { key, log };
  };

  const reviews = (await db.getAll("reviews")) as Review[];
  const reviewKeys = await db.getAllKeys("reviews");
  const pushedText = new Map<string, string | undefined>();
  const migrated: [IDBValidKey, Review][] = [];
  for (let i = 0; i < reviews.length; i++) {
    const review = reviews[i];
    if (typeof review.key === "string") continue;
    const { key, log } = locate(review.cardHash);
    const month = v1MonthOf(review);
    const pushedKey = v1PushedKey(log, month);
    if (!pushedText.has(pushedKey)) {
      pushedText.set(pushedKey, await db.get("meta", pushedKey));
    }
    const v1Pushed = pushedText.get(pushedKey)?.split("\n").includes(logLine(review)) ?? false;
    migrated.push([
      reviewKeys[i],
      {
        ...review,
        key,
        log,
        tz: utcOffsetMinutes(review.reviewedAt),
        ...(v1Pushed ? { v1Pushed } : {}),
      },
    ]);
  }

  const performances = (await db.getAll("performances")) as (ReviewedPerformance & { hash: string })[];
  const baselines: LocalBaseline[] = [];
  const seeds: StateRecord[] = [];
  for (const perf of performances) {
    const { key, log } = locate(perf.hash);
    baselines.push({
      log,
      event: {
        v: 2,
        kind: "baseline",
        card: keyInLog(log, key),
        at: perf.lastReviewedAt,
        s: perf.stability,
        d: perf.difficulty,
        reps: perf.reviewCount,
        src: "v1",
      },
    });
    seeds.push(seedRecord(key, perf));
  }

  const session = (await db.get("session", SESSION_KEY)) as DrillSession | undefined;

  const tx = db.transaction(
    ["deckFiles", "reviews", "performances", "baselines", "states", "session", "meta"],
    "readwrite"
  );
  for (const file of stale) tx.objectStore("deckFiles").put(file);
  if (stale.length > 0) {
    tx.objectStore("meta").delete(IDBKeyRange.bound("tree_etag:", "tree_etag:￿"));
  }
  for (const [id, review] of migrated) tx.objectStore("reviews").put(review, id);
  for (const baseline of baselines) tx.objectStore("baselines").add(baseline);
  for (const seed of seeds) tx.objectStore("states").put(seed);
  tx.objectStore("performances").clear();
  if (session) {
    const toKey = (hash: string) => (byHash.has(hash) ? stateKey(byHash.get(hash)!) : hash);
    tx.objectStore("session").put(
      {
        ...session,
        queue: session.queue.map(toKey),
        completed: session.completed.map(toKey),
        gradedNew: session.gradedNew.map(toKey),
      },
      SESSION_KEY
    );
  }
  tx.objectStore("meta").put(true, "keys_migrated");
  await tx.done;
}


/**
 * Add reviews in bulk, as if graded here. Only the demo does this, for the
 * history it makes up so Today and Statistics have something to show; the
 * replay cache is left for `refreshStates` to bring into line.
 */
export async function importReviews(reviews: Review[]): Promise<void> {
  if (reviews.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("reviews", "readwrite");
  for (const review of reviews) tx.store.add(review);
  await tx.done;
}

export async function getAllReviews(): Promise<Review[]> {
  const db = await getDb();
  return db.getAll("reviews");
}

/**
 * Reviews recorded at or after `iso`. Used for the end-of-session summary, so
 * that a session spread over two sittings still reports all of itself. The
 * store has no index on the timestamp; a scan is well within budget at the
 * scale one person's review history reaches.
 */
export async function getReviewsSince(iso: string): Promise<Review[]> {
  const all = await getAllReviews();
  return all.filter((r) => r.reviewedAt >= iso);
}

/**
 * One source file's worth of parsed cards, keyed by repo path and stamped with
 * the blob SHA it was parsed from. The SHA is what lets a sync fetch only the
 * files that actually changed; keeping the parsed cards alongside it means
 * unchanged files are never re-parsed either.
 */
export type DeckFile = {
  /** `owner/repo` — the collection this file came out of. */
  repo: string;
  path: string;
  sha: string;
  cards: Card[];
};

/**
 * Attribute freshly parsed cards to the collection their file came from. The
 * one place a `ParsedCard` becomes a `Card`, so there is a single answer to
 * "who decides which repo a card belongs to".
 */
export function inRepo(cards: ParsedCard[], repo: string): Card[] {
  return cards.map((card) => ({ ...card, repo }));
}

export async function getAllDeckFiles(): Promise<DeckFile[]> {
  const db = await getDb();
  return db.getAll("deckFiles");
}

/** Apply a sync's changes to one collection's files, in one transaction. */
export async function updateDeckFiles(
  updated: DeckFile[],
  removed: { repo: string; path: string }[] = []
): Promise<void> {
  if (updated.length === 0 && removed.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("deckFiles", "readwrite");
  for (const file of updated) tx.store.put(file);
  for (const { repo, path } of removed) tx.store.delete([repo, path]);
  await tx.done;
}

/** Forget a whole collection, for a repository the user has removed. */
export async function forgetRepo(repo: string): Promise<void> {
  const db = await getDb();
  // Its pulled events too: they are another collection's devices' reviews,
  // re-read in full if it is ever added back. Your own reviews of its cards
  // stay — they happened, and they are yours.
  const tx = db.transaction(["deckFiles", "media", "pulled"], "readwrite");
  for (const name of ["deckFiles", "media", "pulled"] as const) {
    const store = tx.objectStore(name);
    for (const file of await store.getAll()) {
      const { path } = file as { repo: string; path: string };
      if ((file as { repo: string }).repo === repo) store.delete([repo, path]);
    }
  }
  await tx.done;
}

export type MediaFile = {
  /** `owner/repo` — the collection the file is in. */
  repo: string;
  path: string;
  /** The blob SHA, so a sync can tell a changed file from one it already has. */
  sha: string;
  type: string;
  bytes: ArrayBuffer;
};

export async function getMedia(
  repo: string,
  path: string
): Promise<MediaFile | undefined> {
  const db = await getDb();
  return db.get("media", [repo, path]);
}

/** The SHA of each file one collection has stored, by path. */
export async function getMediaShas(repo: string): Promise<Map<string, string>> {
  const db = await getDb();
  const shas = new Map<string, string>();
  const range = IDBKeyRange.bound([repo, ""], [repo, "\uffff"]);
  let cursor = await db.transaction("media").store.openCursor(range);
  while (cursor) {
    const { path, sha } = cursor.value as MediaFile;
    shas.set(path, sha);
    cursor = await cursor.continue();
  }
  return shas;
}

export async function updateMedia(
  updated: MediaFile[],
  removed: { repo: string; path: string }[]
): Promise<void> {
  if (updated.length === 0 && removed.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("media", "readwrite");
  for (const file of updated) tx.store.put(file);
  for (const { repo, path } of removed) tx.store.delete([repo, path]);
  await tx.done;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return db.get("meta", key);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put("meta", value, key);
}

const CREDENTIAL_KEY = "github";

/**
 * The GitHub credential lives in its own store rather than in `meta`.
 * Everything in `meta` is sync bookkeeping that would be harmless to dump into
 * a log, a diagnostic export, or the state file; this is the one record in the
 * database that never may be, and a store named for what it holds is the
 * cheapest way to keep that obvious.
 */
export async function readCredential<T>(): Promise<T | undefined> {
  const db = await getDb();
  return db.get("credentials", CREDENTIAL_KEY);
}

export async function writeCredential(value: unknown): Promise<void> {
  const db = await getDb();
  await db.put("credentials", value, CREDENTIAL_KEY);
}

export async function deleteCredential(): Promise<void> {
  const db = await getDb();
  await db.delete("credentials", CREDENTIAL_KEY);
}

const SESSION_KEY = "current";
const GRADE_STORES = ["reviews", "states", "session", "meta"] as const;

/** What `persistReview` changed, for `revertReview` to put back. */
export type PersistedReview = {
  reviewKey: IDBValidKey;
  /** The replay mark before this grade moved it; undefined if there was none. */
  prevMark: ReplayMark | undefined;
};

/**
 * Durably record a single grade: the review (the event this device will push),
 * the card's new state in the replay cache, and the drill position — all in
 * one transaction. A resume must not re-ask a card whose grade was recorded,
 * and the cache must never hold a state its event did not.
 *
 * Called on every grade rather than once per session, because a drill
 * interrupted by a crash or a backgrounded tab must not lose the reviews
 * already answered.
 *
 * The grade was applied to the cache with replay's own step, so the cache is
 * still what replaying everything would give, and the group's watermark moves
 * on to this event. If the event sorts before the watermark — this device's
 * clock behind an event pulled from another — the shortcut does not hold, and
 * the group is marked for a full replay instead.
 */
export async function persistReview(
  review: Review,
  state: StateRecord,
  order: EventOrder,
  session: DrillSession,
  compare: (a: EventOrder, b: EventOrder) => number
): Promise<PersistedReview> {
  const db = await getDb();
  const tx = db.transaction(GRADE_STORES, "readwrite");
  const meta = tx.objectStore("meta");
  const markKey = replayMarkKey(state.group);
  const reviewKey = tx.objectStore("reviews").add(review);
  tx.objectStore("states").put(state);
  tx.objectStore("session").put(session, SESSION_KEY);
  const prevMark = (await meta.get(markKey)) as ReplayMark | undefined;
  // No mark means the group has never been replayed here — its cache is a
  // seed, not a replay — so there is nothing to keep in step; the next refresh
  // replays it whole either way.
  if (prevMark) {
    const ahead = prevMark.watermark === null || compare(order, prevMark.watermark) > 0;
    meta.put(
      ahead ? { ...prevMark, watermark: order } : { ...prevMark, stale: true },
      markKey
    );
  }
  const [key] = await Promise.all([reviewKey, tx.done]);
  return { reviewKey: key, prevMark };
}

/** Record drill position with no accompanying grade (re-queue, session start). */
export async function saveSession(session: DrillSession): Promise<void> {
  const db = await getDb();
  await db.put("session", session, SESSION_KEY);
}

export async function loadSession(): Promise<DrillSession | null> {
  const db = await getDb();
  return (await db.get("session", SESSION_KEY)) ?? null;
}

export async function clearSession(): Promise<void> {
  const db = await getDb();
  await db.delete("session", SESSION_KEY);
}

/**
 * Reverse a `persistReview`: the review goes — so it is never pushed, or if it
 * was, the next push rewrites its month file without it — and the card's
 * cached state and the group's replay mark go back to what they were. A card
 * that was new has its record deleted, so it returns to the new-card pool.
 */
export async function revertReview(
  key: string,
  group: string,
  prevState: StateRecord | null,
  persisted: PersistedReview | null,
  session: DrillSession
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(GRADE_STORES, "readwrite");
  if (prevState) tx.objectStore("states").put(prevState);
  else tx.objectStore("states").delete(key);
  if (persisted) {
    tx.objectStore("reviews").delete(persisted.reviewKey);
    if (persisted.prevMark) {
      tx.objectStore("meta").put(persisted.prevMark, replayMarkKey(group));
    }
  }
  tx.objectStore("session").put(session, SESSION_KEY);
  await tx.done;
}

/** Make the next refresh replay `group` from nothing (see `ReplayMark.stale`). */
export async function markReplayStale(group: string): Promise<void> {
  const db = await getDb();
  const mark = (await db.get("meta", replayMarkKey(group))) as ReplayMark | undefined;
  if (mark) await db.put("meta", { ...mark, stale: true }, replayMarkKey(group));
}
