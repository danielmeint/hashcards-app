import { openDB, IDBPDatabase } from "idb";
import { Performance, ReviewedPerformance, Review } from "./types";

const DB_NAME = "hashcards";
const DB_VERSION = 1;

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
      },
    });
  }
  return dbPromise;
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
 * Durably record a single grade: the card's updated scheduling state and the
 * review that produced it, in one transaction. Returns the review's key so the
 * write can be reversed by `revertReview` if the user undoes the grade.
 *
 * Called on every grade rather than once per session — a drill interrupted by a
 * crash or a backgrounded tab must not lose the reviews already answered.
 */
export async function persistReview(
  hash: string,
  perf: ReviewedPerformance,
  review: Review
): Promise<IDBValidKey> {
  const db = await getDb();
  const tx = db.transaction(["performances", "reviews"], "readwrite");
  const reviewKey = tx.objectStore("reviews").add(review);
  tx.objectStore("performances").put(toRecord(hash, perf));
  const [key] = await Promise.all([reviewKey, tx.done]);
  return key;
}

/**
 * Reverse a `persistReview`, restoring the scheduling state the card held
 * beforehand. A card whose previous state was "new" has its record deleted
 * rather than overwritten, so it returns to the new-card pool.
 */
export async function revertReview(
  hash: string,
  prevPerf: Performance,
  reviewKey: IDBValidKey | null
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["performances", "reviews"], "readwrite");
  if (prevPerf.type === "reviewed") {
    tx.objectStore("performances").put(toRecord(hash, prevPerf));
  } else {
    tx.objectStore("performances").delete(hash);
  }
  if (reviewKey !== null) {
    tx.objectStore("reviews").delete(reviewKey);
  }
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
