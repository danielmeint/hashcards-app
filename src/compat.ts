import {
  ConflictError,
  FileEntry,
  GitHubConfig,
  StateFile,
  getBlobText,
  readStateFile,
  repoKey,
  writeStateFile,
} from "./github";
import {
  PulledFile,
  StateRecord,
  getAllDeckFiles,
  getAllReviews,
  getPulledFiles,
  getStateRecords,
  updatePulledFiles,
} from "./db";
import { BaselineEvent, parseFile } from "./core/events";
import { deviceId, pushReviewLog } from "./review-log";
import { REVIEW_LOG_DIR } from "./v1-log";

/**
 * Collections that have not been migrated yet (PLAN-1.0 M4): no data branch,
 * scheduling in `hashcards-state.json` on `main`, history in v1 files under
 * `hashcards-reviews/`, cards mostly without IDs.
 *
 * They keep working exactly as before, read and write, until `hc migrate` is
 * run on them. Read: the state file becomes baseline events and the other
 * devices' v1 logs become review events, held in memory (well, IndexedDB) and
 * replayed with this device's own. Written: the same two v1 files as before,
 * so a device still on an older version of the app sees nothing change. No v2
 * data is ever written to such a repository, and no data branch created in it:
 * moving it over is migration's job, done once and deliberately, not
 * something the app does on the side of a sync.
 */

export const STATE_PATH = "hashcards-state.json";

/** The v1 files in a `main` tree listing — what makes a collection unmigrated. */
export function v1Files(blobs: FileEntry[]): FileEntry[] {
  return blobs.filter(
    (f) =>
      f.path === STATE_PATH ||
      (f.path.startsWith(`${REVIEW_LOG_DIR}/`) && f.path.endsWith(".jsonl"))
  );
}

export function migrationHint(config: GitHubConfig): string {
  return `${repoKey(config)} uses the old format — run \`hc migrate\` to upgrade it.`;
}

/** The state file's cards as baselines. Entries that would not parse are skipped. */
export function stateFileBaselines(state: StateFile): BaselineEvent[] {
  const baselines: BaselineEvent[] = [];
  for (const [hash, perf] of Object.entries(state.cards ?? {})) {
    if (
      !(perf?.stability > 0) ||
      !(perf.difficulty >= 1 && perf.difficulty <= 10) ||
      !Number.isFinite(Date.parse(perf.lastReviewedAt)) ||
      !Number.isInteger(perf.reviewCount) ||
      perf.reviewCount < 0
    ) {
      continue;
    }
    baselines.push({
      v: 2,
      kind: "baseline",
      card: hash,
      at: perf.lastReviewedAt,
      s: perf.stability,
      d: perf.difficulty,
      reps: perf.reviewCount,
      src: "v1",
    });
  }
  return baselines;
}

/**
 * Read the collection's v1 data into the pulled store: the state file, and
 * every other device's v1 log files whose SHA moved. `files` is the v1 files
 * the last listing of `main` found. Returns the state file as read, for the
 * push to merge against.
 */
export async function pullV1(
  config: GitHubConfig,
  files: FileEntry[]
): Promise<{ data: StateFile; sha: string } | null> {
  const repo = repoKey(config);
  const stored = new Map((await getPulledFiles(repo)).map((f) => [f.path, f]));
  const updated: PulledFile[] = [];
  const keep = new Set<string>();

  // Read through the contents API every time, as before: its SHA is what the
  // write has to be based on, and a listing of `main` may be a sync old.
  const state = await readStateFile(config);
  if (state) {
    keep.add(STATE_PATH);
    if (stored.get(STATE_PATH)?.sha !== state.sha) {
      updated.push({ repo, path: STATE_PATH, sha: state.sha, events: stateFileBaselines(state.data) });
    }
  }

  const device = deviceId();
  const logs = files.filter(
    (f) => f.path.startsWith(`${REVIEW_LOG_DIR}/`) && !f.path.endsWith(`.${device}.jsonl`)
  );
  for (const file of logs) {
    keep.add(file.path);
    if (stored.get(file.path)?.sha === file.sha) continue;
    const { events, errors } = parseFile(await getBlobText(config, file.sha));
    for (const error of errors) console.warn(`${repo} ${file.path}:${error.line}: ${error.error}`);
    updated.push({ repo, path: file.path, sha: file.sha, events });
  }

  const removed = [...stored.keys()].filter((path) => !keep.has(path)).map((path) => ({ repo, path }));
  await updatePulledFiles(updated, removed);
  return state;
}

type StateEntry = StateFile["cards"][string];

function toEntry(record: StateRecord): StateEntry {
  return {
    lastReviewedAt: record.lastReviewedAt,
    stability: record.stability,
    difficulty: record.difficulty,
    intervalRaw: record.intervalRaw,
    intervalDays: record.intervalDays,
    dueDate: record.dueDate,
    reviewCount: record.reviewCount,
  };
}

/**
 * The state file this device would write: the remote one, with every card
 * this device has a later review of replaced by its replayed state.
 *
 * Remote entries are kept verbatim otherwise, so a sync that learned nothing
 * new writes nothing — even though replay, recomputing a due date at today's
 * retention and with deterministic fuzz, may disagree with what an older
 * version of the app wrote there. A card is only rewritten when this device
 * actually has something newer to say about it, which is the last-write-wins
 * rule the file has always had.
 */
export async function mergedStateFile(
  repo: string,
  remote: StateFile | null
): Promise<StateFile> {
  const cards: Record<string, StateEntry> = { ...(remote?.cards ?? {}) };
  // The file is keyed by v1 hash; replay by key. A card the collection holds
  // now knows both; one it no longer holds is found through the remote file
  // (an `h:` key is a hash prefix) or this device's own reviews of it.
  const hashOf = new Map<string, string>();
  for (const review of await getAllReviews()) {
    if (review.log === repo) hashOf.set(review.key, review.cardHash);
  }
  for (const hash of Object.keys(cards)) hashOf.set(`${repo}/h:${hash.slice(0, 16)}`, hash);
  for (const file of await getAllDeckFiles()) {
    if (file.repo !== repo) continue;
    for (const card of file.cards) {
      hashOf.set(`${repo}/${card.key || `h:${card.hash.slice(0, 16)}`}`, card.hash);
    }
  }

  for (const record of await getStateRecords()) {
    if (record.group !== repo) continue;
    const hash = hashOf.get(record.key);
    if (!hash) continue;
    const theirs = cards[hash];
    if (!theirs || record.lastReviewedAt > theirs.lastReviewedAt) cards[hash] = toEntry(record);
  }
  return { version: 1, cards };
}

/**
 * How many times a push re-reads and retries before reporting failure — see
 * `fullSync` before M3 for why bounded. Shared with the data branch's retry.
 */
export const CONFLICT_RETRIES = 2;

/**
 * Write the state file and this device's v1 log files, as before M3.
 *
 * The state file is written against the SHA it was read with, so a second
 * device committing in between makes GitHub refuse; the merge is last-write-
 * wins per card and idempotent, so the answer is to read again and retry. Its
 * pulled copy is refreshed on the way, so the state the app shows includes
 * whatever that other device wrote.
 *
 * Returns whether remote is now in step with local.
 */
export async function pushV1(
  config: GitHubConfig,
  files: FileEntry[],
  remote: { data: StateFile; sha: string } | null,
  canPush: boolean
): Promise<boolean> {
  const repo = repoKey(config);
  let current = remote;
  for (let attempt = 0; ; attempt++) {
    const merged = await mergedStateFile(repo, current?.data ?? null);
    const unchanged = current
      ? JSON.stringify(current.data) === JSON.stringify(merged)
      : Object.keys(merged.cards).length === 0;
    if (unchanged) break;
    if (!canPush) return false;
    try {
      await writeStateFile(config, merged, current?.sha);
      break;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= CONFLICT_RETRIES) throw e;
      current = await pullV1(config, files);
    }
  }
  if (canPush) await pushReviewLog(config);
  return true;
}
