import { Card, ReviewedPerformance } from "./types";
import {
  GitHubConfig,
  SyncProgress,
  listMdFiles,
  getFilesContent,
  readStateFile,
  writeStateFile,
  StateFile,
  ConflictError,
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
import { AuthError } from "./auth";

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
  return start(config, { cards: true, push: true });
}

/**
 * Push review state without re-fetching cards — nothing about the repo has
 * changed just because a session ended. Joins a sync already in progress rather
 * than racing it: two writers interleaving on the state file is how a merge
 * gets lost.
 */
export function syncStateOnly(config: GitHubConfig): Promise<boolean> {
  return start(config, { cards: false, push: true });
}

/**
 * Take up a repository the user has just pointed the app at: fetch its cards
 * and pull whatever scheduling it already holds, but push nothing back.
 *
 * Choosing a repository in a list is not consent to commit to it. Pushing here
 * meant a mis-tap in the picker wrote the whole local review history into
 * whatever repo was under the finger — which is how this app's own source repo
 * acquired an 87-card `hashcards-state.json`. The first push is the one after
 * a drill, by which point the user has reviewed cards that came *from* this
 * repo.
 */
export function adoptRepo(config: GitHubConfig): Promise<boolean> {
  return start(config, { cards: true, push: false });
}

type SyncScope = { cards: boolean; push: boolean };

function start(config: GitHubConfig, scope: SyncScope): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = exclusive(() => runSync(config, scope)).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The chain every repository operation hangs off, so no two overlap. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `work` with nothing else touching the repository or the deck store.
 *
 * Two different waits, which is why this is not just `inFlight`. A second sync
 * *joins* the one in progress, because it would do the same work — that is
 * `start` above. Anything else **queues**: a card edit handed back the result
 * of a sync that happened to be running would be a write that never happened.
 *
 * Without this, an edit could commit in the window between a sync listing the
 * tree and writing what it found, leaving the deck store holding the pre-edit
 * file under an ETag saying it is current. The next sync repairs that, since
 * the ETag is stale — but "repaired one sync later" is not the same as right,
 * and auto-sync fires on `visibilitychange`, which is exactly when a phone
 * comes back from the editor.
 *
 * A failure must not poison the chain: the queue advances on rejection, and the
 * rejection goes to the caller rather than to whoever is next in line.
 */
export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function runSync(
  config: GitHubConfig,
  scope: SyncScope
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
    if (scope.cards) await syncCards(config, report);
    const inStep = await fullSync(config, scope.push, report);
    recordSyncSuccess(inStep);
    setSyncStatus({ phase: "idle" });
    return true;
  } catch (e) {
    // A credential that is gone or refused is not a retryable failure, and a
    // view that offers "Try again" for it is offering a button that cannot work.
    setSyncStatus({
      phase: "error",
      message: (e as Error).message,
      needsSignIn: e instanceof AuthError,
    });
    return false;
  }
}

const TREE_ETAG_KEY = "tree_etag";

/** Display name for a file, before any frontmatter `name` overrides it. */
export function deckNameFor(path: string): string {
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

/**
 * Every card currently known, from the deck store. Exported so an edit this app
 * made itself can refresh the cache without a round trip for bytes it just sent.
 */
export async function loadCards(): Promise<Card[]> {
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

/**
 * Merge remote scheduling into local, last-write-wins per card.
 *
 * Pure, and idempotent: merging an already-merged set against a newer remote
 * gives the same answer as merging both from scratch. That is what makes the
 * conflict retry below safe to do without asking anyone.
 */
function mergeState(
  local: Record<string, ReviewedPerformance>,
  remoteCards: Record<string, unknown>
): Record<string, ReviewedPerformance> {
  const merged: Record<string, ReviewedPerformance> = {};
  const allHashes = new Set([
    ...Object.keys(local),
    ...Object.keys(remoteCards),
  ]);

  for (const hash of allHashes) {
    const localPerf = local[hash];
    const remotePerf = remoteCards[hash] as ReviewedPerformance | undefined;

    if (localPerf && remotePerf) {
      // LWW: keep the one with the later lastReviewedAt
      merged[hash] =
        localPerf.lastReviewedAt >= remotePerf.lastReviewedAt
          ? localPerf
          : { ...remotePerf, type: "reviewed" };
    } else if (localPerf) {
      merged[hash] = localPerf;
    } else if (remotePerf) {
      merged[hash] = { ...remotePerf, type: "reviewed" };
    }
  }

  return merged;
}

/** The merged set as the repo stores it — scheduling only, no local bookkeeping. */
function toStateFile(merged: Record<string, ReviewedPerformance>): StateFile {
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
  return stateFile;
}

/**
 * How many times a push will re-merge and try again before reporting failure.
 * Bounded because a conflict that keeps recurring is no longer a race with one
 * other device — it is something that will still be true on the next attempt,
 * and hammering the contents API is not a way to find out which.
 */
const CONFLICT_RETRIES = 2;

/**
 * Merge review state with the repo, last-write-wins per card.
 *
 * The SHA sent with a write is the one read at the top of this function, so a
 * second device committing in between makes GitHub refuse the push — correctly,
 * since accepting it would drop whatever that device had recorded. Losing that
 * race is not a failure worth showing anyone: the merge is per-card LWW and
 * idempotent, so the answer is to read the new state, merge again, and push
 * that. Before 1.5 this surfaced as nothing at all; now it would surface as a
 * red "Try again" for something the app can settle by itself.
 *
 * Returns whether remote is now in step with local — false when there was a
 * difference this call declined to push. The caller records that, so a run of
 * declined or skipped pushes is visible as reviews that never left the device
 * rather than as a "Synced just now" that means nothing.
 */
export async function fullSync(
  config: GitHubConfig,
  push: boolean = true,
  onProgress?: (progress: SyncProgress) => void
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    onProgress?.({
      phase: attempt === 0 ? "Fetching review state" : "Merging a newer change",
    });
    const remote = await readStateFile(config);

    // Local is re-read on every attempt, not just the first: a merge writes
    // back into IndexedDB, and a retry has to build on that rather than on the
    // state this sync started with.
    const merged = mergeState(await exportState(), remote?.data?.cards || {});
    await importState(merged);

    const stateFile = toStateFile(merged);

    // A repo we hold no cards for is not a repo whose scheduling we own, so
    // writing a state file into it says something untrue about it. This is the
    // backstop under `adoptRepo`: it also catches a repo that was configured by
    // hand, and one whose card files have all been deleted.
    const canPush = push && (await loadCachedCards()).length > 0;

    const remoteJson = remote ? JSON.stringify(remote.data) : null;
    if (remoteJson === JSON.stringify(stateFile)) return true;
    if (!canPush) return false;

    onProgress?.({ phase: "Saving review state" });
    try {
      await writeStateFile(config, stateFile, remote?.sha);
      return true;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= CONFLICT_RETRIES) throw e;
    }
  }
}
