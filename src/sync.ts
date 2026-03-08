import { Card, ReviewedPerformance } from "./types";
import {
  GitHubConfig,
  listMdFiles,
  getFilesContent,
  readStateFile,
  writeStateFile,
  StateFile,
} from "./github";
import { exportState, importState } from "./db";
import { parseFile } from "./parser";

let cachedCards: Card[] | null = null;

export function getCachedCards(): Card[] | null {
  return cachedCards;
}

export async function syncCards(config: GitHubConfig): Promise<Card[]> {
  const files = await listMdFiles(config);
  const paths = files.map((f) => f.path);
  const contents = await getFilesContent(config, paths);

  const allCards: Card[] = [];
  for (const [path, content] of contents) {
    const deckName = path
      .split("/")
      .pop()!
      .replace(/\.md$/, "");
    try {
      const cards = await parseFile(content, path, deckName);
      allCards.push(...cards);
    } catch (e) {
      console.warn(`Failed to parse ${path}:`, e);
    }
  }

  // Store in localStorage for offline use
  localStorage.setItem("cached_cards", JSON.stringify(allCards));
  cachedCards = allCards;
  return allCards;
}

export function loadCachedCards(): Card[] {
  if (cachedCards) return cachedCards;
  const stored = localStorage.getItem("cached_cards");
  if (stored) {
    cachedCards = JSON.parse(stored);
    return cachedCards!;
  }
  return [];
}

export async function fullSync(config: GitHubConfig): Promise<void> {
  // 1. Fetch remote state
  const remote = await readStateFile(config);

  // 2. Read local state
  const local = await exportState();

  // 3. Merge: LWW per card
  const merged: Record<string, ReviewedPerformance> = {};

  const remoteCards = remote?.data?.cards || {};
  const allHashes = new Set([
    ...Object.keys(local),
    ...Object.keys(remoteCards),
  ]);

  for (const hash of allHashes) {
    const localPerf = local[hash];
    const remotePerf = remoteCards[hash] as ReviewedPerformance | undefined;

    if (localPerf && remotePerf) {
      // LWW: keep the one with the later lastReviewedAt
      if (localPerf.lastReviewedAt >= remotePerf.lastReviewedAt) {
        merged[hash] = localPerf;
      } else {
        merged[hash] = { ...remotePerf, type: "reviewed" };
      }
    } else if (localPerf) {
      merged[hash] = localPerf;
    } else if (remotePerf) {
      merged[hash] = { ...remotePerf, type: "reviewed" };
    }
  }

  // 4. Write merged state to IndexedDB
  await importState(merged);

  // 5. Write merged state to GitHub (skip if unchanged)
  const stateFile: StateFile = { version: 1, cards: {} };
  for (const [hash, perf] of Object.entries(merged)) {
    stateFile.cards[hash] = {
      lastReviewedAt: perf.lastReviewedAt,
      stability: perf.stability,
      difficulty: perf.difficulty,
      intervalRaw: perf.intervalRaw,
      intervalDays: perf.intervalDays,
      dueDate: perf.dueDate,
      reviewCount: perf.reviewCount,
    };
  }

  const remoteJson = remote ? JSON.stringify(remote.data) : null;
  const mergedJson = JSON.stringify(stateFile);
  if (remoteJson !== mergedJson) {
    await writeStateFile(config, stateFile, remote?.sha);
  }
}
