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

export async function getPerformance(hash: string): Promise<Performance> {
  const db = await getDb();
  const record = await db.get("performances", hash);
  if (!record) {
    return { type: "new" };
  }
  return {
    type: "reviewed",
    lastReviewedAt: record.lastReviewedAt,
    stability: record.stability,
    difficulty: record.difficulty,
    intervalRaw: record.intervalRaw,
    intervalDays: record.intervalDays,
    dueDate: record.dueDate,
    reviewCount: record.reviewCount,
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

export async function saveSessionResults(
  cache: Map<string, Performance>,
  reviews: Review[]
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["performances", "reviews"], "readwrite");

  for (const [hash, perf] of cache) {
    if (perf.type === "reviewed") {
      await tx.objectStore("performances").put({
        hash,
        lastReviewedAt: perf.lastReviewedAt,
        stability: perf.stability,
        difficulty: perf.difficulty,
        intervalRaw: perf.intervalRaw,
        intervalDays: perf.intervalDays,
        dueDate: perf.dueDate,
        reviewCount: perf.reviewCount,
      });
    }
  }

  for (const review of reviews) {
    await tx.objectStore("reviews").add(review);
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
    await tx.store.put({
      hash,
      lastReviewedAt: perf.lastReviewedAt,
      stability: perf.stability,
      difficulty: perf.difficulty,
      intervalRaw: perf.intervalRaw,
      intervalDays: perf.intervalDays,
      dueDate: perf.dueDate,
      reviewCount: perf.reviewCount,
    });
  }
  await tx.done;
}
