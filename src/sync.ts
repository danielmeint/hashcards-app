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
import {
  DeckFile,
  exportState,
  getAllDeckFiles,
  getMeta,
  importState,
  setMeta,
  updateDeckFiles,
} from "./db";
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

const TREE_ETAG_KEY = "tree_etag";

/** Display name for a file, before any frontmatter `name` overrides it. */
function deckNameFor(path: string): string {
  return path
    .split("/")
    .pop()!
    .replace(/\.md$/, "");
}

/**
 * Bring the local card set up to date with the repo.
 *
 * Two things keep this cheap. The tree request is conditional, so the ordinary
 * case — nothing has changed since last time — costs a single 304 that does not
 * count against the rate limit. When the tree *has* changed, only files whose
 * blob SHA moved are fetched; the rest keep the cards they were already parsed
 * into. Before this, every startup listed the tree and then fetched every file
 * in the repo, whether or not a single byte had changed.
 */
export async function syncCards(
  config: GitHubConfig,
  onProgress?: (progress: SyncProgress) => void
): Promise<Card[]> {
  onProgress?.({ phase: "Checking for changes" });
  const etag = await getMeta<string>(TREE_ETAG_KEY);
  const listing = await listMdFiles(config, etag);

  if (!listing.changed) return loadCards();

  const stored = new Map(
    (await getAllDeckFiles()).map((file) => [file.path, file])
  );
  const wanted = new Set(listing.files.map((f) => f.path));
  const stale = listing.files.filter(
    (f) => stored.get(f.path)?.sha !== f.sha
  );
  const removed = [...stored.keys()].filter((path) => !wanted.has(path));

  const updated: DeckFile[] = [];
  if (stale.length > 0) {
    const contents = await getFilesContent(
      config,
      stale.map((f) => f.path),
      onProgress
    );

    onProgress?.({ phase: "Parsing cards" });
    for (const file of stale) {
      const content = contents.get(file.path);
      if (content === undefined) continue;
      let cards: Card[] = [];
      try {
        cards = await parseFile(content, file.path, deckNameFor(file.path));
      } catch (e) {
        // Recorded anyway, with the SHA and no cards: re-fetching the same
        // bytes cannot parse differently, and editing the file to fix it will
        // move the SHA and bring it back.
        console.warn(`Failed to parse ${file.path}:`, e);
      }
      updated.push({ path: file.path, sha: file.sha, cards });
    }
  }

  await updateDeckFiles(updated, removed);
  // Only now, and only if every fetch above succeeded — a failure throws out of
  // here, so the tag is never recorded for a state we did not reach. Recording
  // it early would make the next sync report "nothing changed" over files we
  // never actually got.
  await setMeta(TREE_ETAG_KEY, listing.etag);

  return loadCards();
}

/** Every card currently known, from the deck store. */
async function loadCards(): Promise<Card[]> {
  const files = await getAllDeckFiles();
  files.sort((a, b) => a.path.localeCompare(b.path));
  cachedCards = files.flatMap((f) => f.cards);
  return cachedCards;
}

/**
 * Cards for rendering, from memory if this session has already read them.
 * Kept in memory because the deck list re-reads on every render and after every
 * sync, and the whole point of the startup path is that it does no waiting.
 */
export async function loadCachedCards(): Promise<Card[]> {
  return cachedCards ?? loadCards();
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
