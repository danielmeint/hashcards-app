import { openDB, IDBPDatabase } from "idb";
import { legacy } from "./settings";
import {
  Card,
  DrillSession,
  ParsedCard,
  Performance,
  ReviewedPerformance,
  Review,
} from "./types";

const DB_NAME = "hashcards";
const DB_VERSION = 6;


let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
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

function toRecord(hash: string, perf: ReviewedPerformance) {
  return {
    hash,
    lastReviewedAt: perf.lastReviewedAt,
    stability: perf.stability,
    difficulty: perf.difficulty,
    intervalRaw: perf.intervalRaw,
    intervalDays: perf.intervalDays,
    dueDate: perf.dueDate,
    reviewCount: perf.reviewCount,
  };
}

export async function getAllPerformances(): Promise<
  Map<string, ReviewedPerformance>
> {
  const db = await getDb();
  const all = await db.getAll("performances");
  const map = new Map<string, ReviewedPerformance>();
  for (const record of all) {
    map.set(record.hash, {
      type: "reviewed",
      lastReviewedAt: record.lastReviewedAt,
      stability: record.stability,
      difficulty: record.difficulty,
      intervalRaw: record.intervalRaw,
      intervalDays: record.intervalDays,
      dueDate: record.dueDate,
      reviewCount: record.reviewCount,
    });
  }
  return map;
}

export async function getDueCardHashes(today: string): Promise<Set<string>> {
  const db = await getDb();
  const all = await db.getAll("performances");
  const due = new Set<string>();
  for (const record of all) {
    if (record.dueDate <= today) {
      due.add(record.hash);
    }
  }
  return due;
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
  const tx = db.transaction("deckFiles", "readwrite");
  for (const file of await tx.store.getAll()) {
    if ((file as DeckFile).repo === repo) {
      tx.store.delete([repo, (file as DeckFile).path]);
    }
  }
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
const SESSION_STORES = ["performances", "reviews", "session"] as const;

/**
 * Durably record a single grade: the card's updated scheduling state, the
 * review that produced it, and the resulting drill position — all in one
 * transaction. Returns the review's key so the write can be reversed by
 * `revertReview` if the user undoes the grade.
 *
 * Called on every grade rather than once per session, because a drill
 * interrupted by a crash or a backgrounded tab must not lose the reviews
 * already answered. The session snapshot shares the transaction so the two can
 * never disagree: a resume must not re-ask a card whose grade was recorded.
 */
export async function persistReview(
  hash: string,
  perf: ReviewedPerformance,
  review: Review,
  session: DrillSession
): Promise<IDBValidKey> {
  const db = await getDb();
  const tx = db.transaction(SESSION_STORES, "readwrite");
  const reviewKey = tx.objectStore("reviews").add(review);
  tx.objectStore("performances").put(toRecord(hash, perf));
  tx.objectStore("session").put(session, SESSION_KEY);
  const [key] = await Promise.all([reviewKey, tx.done]);
  return key;
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
 * Reverse a `persistReview`, restoring the scheduling state the card held
 * beforehand. A card whose previous state was "new" has its record deleted
 * rather than overwritten, so it returns to the new-card pool.
 */
export async function revertReview(
  hash: string,
  prevPerf: Performance,
  reviewKey: IDBValidKey | null,
  session: DrillSession
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(SESSION_STORES, "readwrite");
  if (prevPerf.type === "reviewed") {
    tx.objectStore("performances").put(toRecord(hash, prevPerf));
  } else {
    tx.objectStore("performances").delete(hash);
  }
  if (reviewKey !== null) {
    tx.objectStore("reviews").delete(reviewKey);
  }
  tx.objectStore("session").put(session, SESSION_KEY);
  await tx.done;
}

/**
 * Carry a card's history onto the hash it has after an edit.
 *
 * Identity is a hash of the content, so fixing a typo produces a different card
 * as far as everything downstream is concerned. Nothing else in the app can put
 * the two together — but an edit made *here* knows both hashes at once, which
 * is the whole reason editing in the app beats editing on GitHub.
 *
 * Reviews move: each one happened once, and leaving copies behind would
 * double-count them in the heatmap. The performance is copied rather than
 * moved, because other devices still hold the old card until they sync, and an
 * orphaned performance is how this app has always carried a card that is
 * temporarily absent.
 */
export async function migrateCardHistory(
  from: string,
  to: string
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["performances", "reviews"], "readwrite");
  const perf = await tx.objectStore("performances").get(from);
  if (perf) tx.objectStore("performances").put({ ...perf, hash: to });

  let cursor = await tx.objectStore("reviews").openCursor();
  while (cursor) {
    const review = cursor.value as Review;
    if (review.cardHash === from) cursor.update({ ...review, cardHash: to });
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Every card the app has an origin for, as hash → `owner/repo`. */
export async function getAllOrigins(): Promise<Map<string, string>> {
  const db = await getDb();
  const tx = db.transaction("origins");
  const [keys, values] = await Promise.all([
    tx.store.getAllKeys(),
    tx.store.getAll(),
  ]);
  const origins = new Map<string, string>();
  keys.forEach((key, i) => origins.set(String(key), values[i] as string));
  return origins;
}

/**
 * Note that these cards were seen in this collection.
 *
 * Last-seen rather than first-seen: a card that moves from one repository to
 * another belongs to the one holding it now, and its scheduling should follow
 * it rather than stay behind in a file that no longer has the card.
 */
export async function recordOrigins(
  hashes: Iterable<string>,
  repoKey: string
): Promise<void> {
  const existing = await getAllOrigins();
  const moved = [...hashes].filter((hash) => existing.get(hash) !== repoKey);
  if (moved.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("origins", "readwrite");
  for (const hash of moved) tx.store.put(repoKey, hash);
  await tx.done;
}

export async function exportState(): Promise<
  Record<string, ReviewedPerformance>
> {
  const map = await getAllPerformances();
  const obj: Record<string, ReviewedPerformance> = {};
  for (const [hash, perf] of map) {
    obj[hash] = perf;
  }
  return obj;
}

export async function importState(
  merged: Record<string, ReviewedPerformance>
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("performances", "readwrite");
  for (const [hash, perf] of Object.entries(merged)) {
    tx.store.put(toRecord(hash, perf));
  }
  await tx.done;
}
