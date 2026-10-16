import { Card } from "./types";
import {
  ConflictError,
  DATA_BRANCH,
  GitHubConfig,
  RepoConfig,
  SyncProgress,
  getConfig,
  getRef,
  getRepos,
  repoKey,
  listMdFiles,
  getFilesContent,
  getBlob,
  FileEntry,
} from "./github";
import {
  DeckFile,
  getAllDeckFiles,
  getMeta,
  inRepo,
  markReplayStale,
  setMeta,
  updateDeckFiles,
  getMediaShas,
  updateMedia,
  MediaFile,
} from "./db";
import { forgetMediaUrl, mediaRefs, mediaType } from "./media";
import { parseFile } from "./parser";
import { recordSyncSuccess, setSyncStatus } from "./sync-state";
import { AuthError } from "./auth";
import { isDeckPath } from "./collection-config";
import {
  CONFIG_PATH,
  adoptReviewConfig,
  cachedCollectionConfig,
  pushCollectionSettings,
  readCollectionConfig,
} from "./collection-settings";
import { CONFLICT_RETRIES, migrationHint, pullV1, pushV1, v1Files } from "./compat";
import { pullDataBranch, pushDataBranch } from "./data-branch";
import { refreshStates } from "./review-state";
import { settings } from "./settings";
import { applyPending, pendingOps } from "./inbox-queue";
import { conflictNotice, runInboxFlush } from "./inbox-commit";
import { v1FilesKey as v1FilesKeyOf } from "./v1-log";
import { isDemo } from "./demo-mode";

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
export function syncAll(config: RepoConfig): Promise<boolean> {
  return start(config, { cards: true, push: true });
}

/**
 * Every configured collection, in order, then the review state.
 *
 * Cards are fetched from all of them; review data is read from and written to
 * only the ones the app may write to. A subscription is someone else's
 * repository — your reviews of its cards are yours, and they go in your own
 * collection's data branch.
 */
export function syncEverything(): Promise<boolean> {
  const repos = getRepos();
  if (repos.length === 0) return Promise.resolve(false);
  return start(repos[0], { cards: true, push: true, all: repos });
}

/**
 * Push reviews without re-fetching cards — nothing about the repo has changed
 * just because a session ended. Joins a sync already in progress rather than
 * racing it: two writers building on one tip is a race one of them loses.
 */
export function syncStateOnly(config: RepoConfig): Promise<boolean> {
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
export function adoptRepo(config: RepoConfig): Promise<boolean> {
  return start(config, { cards: true, push: false });
}

type SyncScope = {
  cards: boolean;
  push: boolean;
  /** Every collection to visit; just `config` when absent. */
  all?: RepoConfig[];
};

function start(config: RepoConfig, scope: SyncScope): Promise<boolean> {
  if (inFlight) return inFlight;
  const run = isDemo() ? () => demoSync(config, scope) : () => runSync(config, scope);
  inFlight = exclusive(run).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Write the collection settings changed on the Settings screen into
 * `hashcards.toml` now, rather than on the next sync. Called on leaving
 * Settings. Under the same rule as a sync's push: only to your own
 * collection, and only once it has given you cards. A failure is not
 * reported: the change is still marked owed, and the next sync writes it.
 */
export async function pushSettings(): Promise<void> {
  const config = getConfig();
  if (!config || config.readOnly || !navigator.onLine) return;
  if (settings.collectionDirty.get().length === 0) return;
  if (!(await loadCachedCards()).some((c) => c.repo === repoKey(config))) return;
  try {
    await exclusive(() => pushCollectionSettings(config));
  } catch (e) {
    console.warn("Could not save settings to hashcards.toml; the next sync will:", e);
  }
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
  config: RepoConfig,
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
    const repos = scope.all ?? [config];
    const notices: string[] = [];

    // Inbox decisions made offline, or left behind by a closed app, go first:
    // they are the user's own, and the listing below then finds them landed.
    if (scope.push) {
      const notice = await flushInboxQuietly(repos.filter((r) => !r.readOnly), report);
      if (notice) notices.push(notice);
    }

    if (scope.cards) {
      for (const repo of repos) await syncCards(repo, report);
    }

    // One schedule, one new-card budget: the review settings are your own
    // collection's, whichever collections this sync visited.
    const primary = getConfig();
    if (primary && !primary.readOnly) {
      adoptReviewConfig((await cachedCollectionConfig(repoKey(primary))).review);
    }

    // `inStep` is the conjunction: one collection declining to push is still
    // reviews that have not left the device, and the deck list has to say so.
    let inStep = true;
    for (const repo of repos) {
      if (repo.readOnly) continue;
      const result = await syncReviews(repo, scope.push, report);
      inStep = inStep && result.inStep;
      if (result.notice) notices.push(result.notice);
    }
    // Settings changed on the Settings screen since the last sync, or retention
    // adopted from the file just now: every due date follows.
    await refreshStates();

    recordSyncSuccess(inStep);
    setSyncStatus(
      notices.length > 0 ? { phase: "idle", notice: notices.join(" ") } : { phase: "idle" }
    );
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

/**
 * A sync in the demo: the parts of one that mean something without a remote.
 *
 * The demo's repository is the files in `demo-mode.ts`, so the Inbox's queue
 * is committed to them and the cards re-read from them, through the same code
 * a real sync uses. There are no other devices to pull reviews from and
 * nowhere to push them, so they count as in step — they are already in the
 * only copy there is — and Today never warns about reviews left on the device.
 */
async function demoSync(config: RepoConfig, scope: SyncScope): Promise<boolean> {
  if (scope.push) await runInboxFlush([config]);
  if (scope.cards) await syncCards(config);
  await refreshStates();
  recordSyncSuccess(true);
  setSyncStatus({ phase: "idle" });
  return true;
}

/**
 * Commit the Inbox's queue as part of a sync. A failure here is not the
 * sync's: the queue stays, the reviews still go, and the notice says why the
 * drafts did not. Only a refused credential stops everything, as it would
 * anyway one request later.
 */
async function flushInboxQuietly(
  repos: RepoConfig[],
  report: (progress: SyncProgress) => void
): Promise<string | undefined> {
  if ((await pendingOps()).length === 0) return undefined;
  report({ phase: "Saving Inbox" });
  try {
    return conflictNotice((await runInboxFlush(repos)).conflicts);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    console.warn("Could not commit Inbox changes:", e);
    return `Inbox changes not saved yet: ${(e as Error).message}`;
  }
}

/** The v1 files the last full listing of a collection's `main` found. */
const v1FilesKey = (config: GitHubConfig) => v1FilesKeyOf(repoKey(config));

/**
 * Pull, replay and push one collection's review data, in whichever format it
 * is in.
 *
 * - **Migrated, or new** — it has a `hashcards-data` branch, or nothing of v1
 *   on `main` at all: other devices' events come from the branch, and this
 *   device's go back as one commit, creating the branch the first time.
 * - **Not migrated** — v1 files on `main` and no data branch: read and written
 *   as v1 (`compat.ts`), with a hint that `hc migrate` is waiting.
 *
 * Which one is decided afresh every sync, so running the migration on another
 * machine is picked up by the next sync here with nothing to configure.
 *
 * Nothing is pushed to a collection this device holds no cards from. Choosing
 * a repository in a list is not consent to commit to it (see `adoptRepo`), and
 * a repo with no cards — the app's own source repo, say — is not one whose
 * reviews we own.
 */
async function syncReviews(
  config: RepoConfig,
  push: boolean,
  report: (progress: SyncProgress) => void
): Promise<{ inStep: boolean; notice?: string }> {
  const key = repoKey(config);
  const holdsCards = (await loadCachedCards()).some((c) => c.repo === key);
  const canPush = push && holdsCards;

  report({ phase: "Fetching reviews" });
  let head = await getRef(config, DATA_BRANCH);
  // Never listed since M3 (a tree tag from before still answering 304): which
  // format this collection is in is not known, and guessing "new" would put a
  // data branch into a repo that has not been migrated. Listing it settles it.
  if (head === null && (await getMeta(v1FilesKey(config))) === undefined) {
    await syncCards(config, report);
  }
  const files = (await getMeta<FileEntry[]>(v1FilesKey(config))) ?? [];

  if (head === null && files.length > 0) {
    const state = await pullV1(config, files);
    await refreshStates();
    report({ phase: "Saving review state" });
    const inStep = await pushV1(config, files, state, canPush);
    return { inStep, notice: migrationHint(config) };
  }

  for (let attempt = 0; ; attempt++) {
    const pulled = await pullDataBranch(config, head);
    for (const group of pulled.invalid) await markReplayStale(group);
    await refreshStates(pulled.fresh);
    report({ phase: "Saving reviews" });
    try {
      const inStep = await pushDataBranch(config, pulled.tip, canPush);
      if (canPush && repoKey(getConfig() ?? config) === key) {
        await pushCollectionSettings(config);
      }
      return { inStep };
    } catch (e) {
      // Another device moved the branch between our read and our write. Its
      // files are not ours and ours are not its, so there is nothing to
      // merge: read the new tip and build on that.
      if (!(e instanceof ConflictError) || attempt >= CONFLICT_RETRIES) throw e;
      report({ phase: "Merging a newer change" });
      head = await getRef(config, DATA_BRANCH);
    }
  }
}

/**
 * Keyed by repository, not global. The conditional tree request asks "has this
 * changed since the version I have", and the answer is only meaningful about
 * the repo the tag came from — one collection's tag has nothing to say about
 * another's tree.
 */
const treeEtagKey = (config: GitHubConfig) => `tree_etag:${repoKey(config)}`;

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
  // A collection never listed since M3 is listed in full whatever its tag
  // says: what this listing learns besides the decks (`hashcards.toml`, the v1
  // files) was not recorded by the listing the tag belongs to.
  const known = (await getMeta(v1FilesKey(config))) !== undefined;
  const etag = known ? await getMeta<string>(treeEtagKey(config)) : null;
  const listing = await listMdFiles(config, etag);

  if (!listing.changed) return loadCards();

  const key = repoKey(config);
  // Which Markdown files are decks is the collection's to say, in its
  // `hashcards.toml`. Every one of them, when it says nothing.
  const collection = await readCollectionConfig(
    config,
    listing.blobs.find((f) => f.path === CONFIG_PATH)
  );
  const decks = listing.files.filter((f) => isDeckPath(f.path, collection.decks));
  // Only this collection's files: another one's `Algebra.md` is a different
  // file that happens to share a name, and comparing SHAs across the two would
  // have each repeatedly declare the other stale.
  const stored = new Map(
    (await getAllDeckFiles())
      .filter((file) => file.repo === key)
      .map((file) => [file.path, file])
  );
  const wanted = new Set(decks.map((f) => f.path));
  const stale = decks.filter(
    (f) => stored.get(f.path)?.sha !== f.sha
  );
  const removed = [...stored.keys()]
    .filter((path) => !wanted.has(path))
    .map((path) => ({ repo: key, path }));

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
        cards = inRepo(
          await parseFile(content, file.path, deckNameFor(file.path)),
          key
        );
      } catch (e) {
        // Recorded anyway, with the SHA and no cards: re-fetching the same
        // bytes cannot parse differently, and editing the file to fix it will
        // move the SHA and bring it back.
        console.warn(`Failed to parse ${file.path}:`, e);
      }
      updated.push({ repo: key, path: file.path, sha: file.sha, cards });
    }
  }

  await updateDeckFiles(updated, removed);
  await syncMedia(config, listing.media, onProgress);
  // Only now, and only if every fetch above succeeded — a failure throws out of
  // here, so the tag is never recorded for a state we did not reach. Recording
  // it early would make the next sync report "nothing changed" over files we
  // never actually got.
  await setMeta(v1FilesKey(config), v1Files(listing.blobs));
  await setMeta(treeEtagKey(config), listing.etag);

  return loadCards();
}

/**
 * Bring the stored images and audio in line with what this collection's cards
 * reference: fetch what is new or changed, drop what nothing points at.
 *
 * Only referenced files. A repository's other pictures — a README screenshot,
 * a logo — are none of the app's business, and fetching them would cost a
 * request each for nothing.
 */
async function syncMedia(
  config: GitHubConfig,
  inTree: FileEntry[],
  onProgress?: (progress: SyncProgress) => void
): Promise<void> {
  const key = repoKey(config);
  const referenced = new Set(
    (await getAllDeckFiles())
      .filter((file) => file.repo === key)
      .flatMap((file) => file.cards.flatMap((card) => mediaRefs(card)))
  );
  const wanted = inTree.filter((f) => referenced.has(f.path));
  const stored = await getMediaShas(key);
  const stale = wanted.filter((f) => stored.get(f.path) !== f.sha);
  const keep = new Set(wanted.map((f) => f.path));
  const removed = [...stored.keys()]
    .filter((path) => !keep.has(path))
    .map((path) => ({ repo: key, path }));

  const fetched: MediaFile[] = [];
  const concurrency = 5;
  for (let i = 0; i < stale.length; i += concurrency) {
    const batch = stale.slice(i, i + concurrency);
    onProgress?.({
      phase: "Fetching media",
      current: i,
      total: stale.length,
    });
    fetched.push(
      ...(await Promise.all(
        batch.map(async (f) => ({
          repo: key,
          path: f.path,
          sha: f.sha,
          type: mediaType(f.path) ?? "application/octet-stream",
          bytes: await getBlob(config, f.sha),
        }))
      ))
    );
  }

  await updateMedia(fetched, removed);
  for (const { path } of [...fetched, ...removed]) forgetMediaUrl(key, path);
}

/**
 * Every card currently known, from the deck store. Exported so an edit this app
 * made itself can refresh the cache without a round trip for bytes it just sent.
 */
export async function loadCards(): Promise<Card[]> {
  const files = await getAllDeckFiles();
  files.sort(
    (a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path)
  );
  // Attributed from the file rather than trusted from the card. The file is
  // what the deck store is keyed by, so it cannot be wrong about which
  // collection it came from; a card carrying its own stale answer can be, and
  // was — the first migration into the keyed store stamped the file and left
  // every card inside it saying nothing.
  // With the Inbox's queued decisions laid over them: a kept draft is a new
  // card from the moment it is kept, not from the moment it is committed.
  cachedCards = applyPending(
    files.flatMap((f) => inRepo(f.cards, f.repo)),
    await pendingOps()
  );
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
