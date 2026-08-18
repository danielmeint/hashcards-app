import { Card, ReviewedPerformance } from "./types";
import {
  GitHubConfig,
  SyncProgress,
  listMdFiles,
  getFilesContent,
  readStateFile,
  writeStateFile,
  StateFile,
} from "./github";
import { exportState, importState } from "./db";
import { parseFile } from "./parser";
import { recordSyncSuccess, setSyncStatus } from "./sync-state";

let cachedCards: Card[] | null = null;

export function getCachedCards(): Card[] | null {
  return cachedCards;
}

let inFlight: Promise<boolean> | null = null;

/**
 * Cards then review state, reporting through `sync-state` rather than to a
 * caller: nothing waits for this any more, so the status the deck list renders
 * is its only channel. Resolves `false` on failure instead of rejecting —
 * every caller is fire-and-forget, and an unhandled rejection is not a way to
 * report a network error. Concurrent callers share a single run.
 */
export function syncAll(config: GitHubConfig): Promise<boolean> {
  return start(config, true);
}

/**
 * Push review state without re-fetching cards — nothing about the repo has
 * changed just because a session ended. Joins a sync already in progress rather
 * than racing it: two writers interleaving on the state file is how a merge
 * gets lost.
 */
export function syncStateOnly(config: GitHubConfig): Promise<boolean> {
  return start(config, false);
}

function start(config: GitHubConfig, includeCards: boolean): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = runSync(config, includeCards).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(
  config: GitHubConfig,
  includeCards: boolean
): Promise<boolean> {
  const report = (progress: SyncProgress) =>
    setSyncStatus({
      phase: "syncing",
      detail:
        progress.current && progress.total
          ? `${progress.phase} (${progress.current}/${progress.total})`
          : progress.phase,
    });

  setSyncStatus({ phase: "syncing", detail: null });
  try {
    if (includeCards) await syncCards(config, report);
    await fullSync(config, report);
    recordSyncSuccess();
    setSyncStatus({ phase: "idle" });
    return true;
  } catch (e) {
    setSyncStatus({ phase: "error", message: (e as Error).message });
    return false;
  }
}

export async function syncCards(
  config: GitHubConfig,
  onProgress?: (progress: SyncProgress) => void
): Promise<Card[]> {
  onProgress?.({ phase: "Listing files" });
  const files = await listMdFiles(config);
  const paths = files.map((f) => f.path);

  const contents = await getFilesContent(config, paths, onProgress);

  onProgress?.({ phase: "Parsing cards" });
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

export async function fullSync(
  config: GitHubConfig,
  onProgress?: (progress: SyncProgress) => void
): Promise<void> {
  // 1. Fetch remote state
  onProgress?.({ phase: "Fetching review state" });
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
    onProgress?.({ phase: "Saving review state" });
    await writeStateFile(config, stateFile, remote?.sha);
  }
}
