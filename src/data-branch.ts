import {
  DATA_BRANCH,
  GitHubConfig,
  TreeChange,
  createCommit,
  createRef,
  createTree,
  getBlobText,
  getConfig,
  getTree,
  getRepos,
  repoKey,
  updateRef,
} from "./github";
import {
  PulledFile,
  SUBSCRIBED_GROUP,
  getAllReviews,
  getLocalBaselines,
  getMeta,
  getPulledFiles,
  getStateRecords,
  groupOf,
  setMeta,
  updatePulledFiles,
} from "./db";
import { ReviewLogEvent, parseFile, serializeEvent } from "./core/events";
import { deviceId, monthFiles, parseMonthFilePath, renameDevice, reviewEvent } from "./review-log";
import { replayOptions } from "./review-state";
import { fingerprint } from "./core/replay";

/**
 * A collection's `hashcards-data` branch (PLAN-1.0 §2.3): every device's
 * review files, and a snapshot of the state they replay to.
 *
 * Pulling reads the tree and fetches only the files whose blob SHA moved since
 * the last pull — and nothing at all when the branch has not moved. Pushing
 * writes this device's changed month files and the snapshot as one commit,
 * built on the tip it pulled, and moves the branch by fast-forward only. Other
 * devices' files are carried over untouched in the base tree; this device only
 * ever writes its own.
 */

/** Where the last pull left the branch: its tip and that commit's tree. */
export type BranchTip = { head: string | null; tree: string | null };

const tipKey = (repo: string) => `data_tip:${repo}`;
/** What this device last pushed to each of its files there, by path. */
const pushedKey = (repo: string) => `data_pushed:${repo}`;

export type Pulled = {
  tip: BranchTip;
  /** Events the pull added, by replay group — what `refreshStates` takes. */
  fresh: Map<string, ReviewLogEvent[]>;
  /**
   * Groups that lost an event: another device undid a pushed grade, or a file
   * went away. Adding on to the cache cannot express that, so these are
   * replayed from nothing.
   */
  invalid: Set<string>;
};

/**
 * Bring this collection's other devices' events up to date, given the tip
 * the branch is at now (`getRef`; null when there is no branch yet).
 */
export async function pullDataBranch(
  config: GitHubConfig,
  head: string | null
): Promise<Pulled> {
  const repo = repoKey(config);
  const fresh = new Map<string, ReviewLogEvent[]>();
  const invalid = new Set<string>();
  const cached = await getMeta<BranchTip>(tipKey(repo));
  // Whatever this collection's v1 files said, the data branch now says
  // instead — migration carried it across, and keeping both would count every
  // review twice.
  const stored = await getPulledFiles(repo);

  if (head !== null && cached?.head === head) {
    return { tip: cached, fresh, invalid };
  }

  const listing = head === null ? { sha: null, entries: [] } : await getTree(config, head);
  await checkOwnFiles(config, listing.entries);
  const device = deviceId();
  const theirs = listing.entries.filter((e) => {
    const name = e.type === "blob" ? parseMonthFilePath(e.path) : null;
    // This device's own files are not read back: the local log is their
    // truth, and reading them would bring back a grade undone since the push.
    return name !== null && name.device !== device;
  });

  const byPath = new Map(stored.map((f) => [f.path, f]));
  const wanted = new Set(theirs.map((e) => e.path));
  const removed = stored.filter((f) => !wanted.has(f.path));
  const changed = theirs.filter((e) => byPath.get(e.path)?.sha !== e.sha);

  const groupsOf = (events: ReviewLogEvent[]) =>
    new Set(events.map((e) => groupOf(repo, e.card)));
  for (const file of removed) for (const g of groupsOf(file.events)) invalid.add(g);

  const updated: PulledFile[] = [];
  const concurrency = 5;
  for (let i = 0; i < changed.length; i += concurrency) {
    const batch = changed.slice(i, i + concurrency);
    const texts = await Promise.all(batch.map((e) => getBlobText(config, e.sha)));
    batch.forEach((entry, j) => {
      const { events, errors } = parseFile(texts[j]);
      // A bad line costs that line, never the file: the rest are reviews that
      // happened. Logged rather than shown — nothing on this device can fix
      // another device's file.
      for (const error of errors) {
        console.warn(`${repo} ${entry.path}:${error.line}: ${error.error}`);
      }
      const before = new Set((byPath.get(entry.path)?.events ?? []).map(serializeEvent));
      const after = new Set(events.map(serializeEvent));
      for (const event of events) {
        if (before.has(serializeEvent(event))) continue;
        const group = groupOf(repo, event.card);
        const list = fresh.get(group);
        if (list) list.push(event);
        else fresh.set(group, [event]);
      }
      for (const line of before) {
        if (after.has(line)) continue;
        const old = byPath.get(entry.path)!.events.find((e) => serializeEvent(e) === line)!;
        invalid.add(groupOf(repo, old.card));
      }
      updated.push({ repo, path: entry.path, sha: entry.sha, events });
    });
  }

  await updatePulledFiles(updated, removed.map(({ path }) => ({ repo, path })));
  const tip: BranchTip = { head, tree: listing.sha };
  await setMeta(tipKey(repo), tip);
  return { tip, fresh, invalid };
}

/**
 * Make sure this device is the only writer of the files under its name.
 *
 * A device writes its files whole, from its local log, and never reads them
 * back. That is safe only while nothing else writes them — and two things can:
 * a second browser carrying the same name (a restored backup, a copied
 * profile), and this same browser after losing its IndexedDB but not its
 * `localStorage`. Either way the next push would overwrite reviews this device
 * has never seen.
 *
 * So before pulling, each of its files on the branch is compared with what it
 * last pushed there. Only one that differs is downloaded, and if it holds a
 * line this device neither pushed nor has, this device takes a new name. Its
 * old files then belong to "another device": they are pulled like any other,
 * never written again, and every review in them is kept. This device's own
 * reviews go into files under the new name; any that were also in the old
 * files are the same lines, which every reader applies once.
 */
async function checkOwnFiles(
  config: GitHubConfig,
  entries: { path: string; sha: string; type: string }[]
): Promise<void> {
  const repo = repoKey(config);
  const device = deviceId();
  const own = entries.filter((e) => e.type === "blob" && parseMonthFilePath(e.path)?.device === device);
  if (own.length === 0) return;
  const pushed = (await getMeta<Record<string, string>>(pushedKey(repo))) ?? {};
  let mine: Set<string> | null = null;
  for (const entry of own) {
    const base = pushed[entry.path];
    if (base !== undefined && (await gitBlobSha(base)) === entry.sha) continue;
    mine ??= new Set([...(await ownFiles(repo)).values()].flatMap(lines));
    const known = new Set([...mine, ...lines(base ?? "")]);
    const { events } = parseFile(await getBlobText(config, entry.sha));
    const foreign = events.map(serializeEvent).filter((line) => !known.has(line));
    if (foreign.length === 0) continue;
    const renamed = renameDevice();
    console.warn(
      `${repo} ${entry.path}: ${foreign.length} review(s) this device did not write. ` +
        `Another writer shares the name ${device}; this device is now ${renamed}.`
    );
    // Nothing is pushed under the new name yet, and nothing under the old one
    // may be touched again — including deleting a month file that "went away".
    for (const r of getRepos()) await setMeta(pushedKey(repoKey(r)), undefined);
    return;
  }
}

const lines = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

/** Git's name for a blob with this content, to tell an unchanged file without fetching it. */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This device's events for this collection's log, as the files they go in. */
async function ownFiles(repo: string): Promise<Map<string, string>> {
  const events: ReviewLogEvent[] = [];
  for (const review of await getAllReviews()) {
    // A review already in a v1 file reaches the data branch through migration.
    if (review.log === repo && !review.v1Pushed) events.push(reviewEvent(review));
  }
  for (const baseline of await getLocalBaselines()) {
    if (baseline.log === repo) events.push(baseline.event);
  }
  return monthFiles(events, deviceId());
}

/**
 * The derived state, for a cold start that would rather not replay the whole
 * log (`snapshot.json`, safe to delete). This collection's own cards, and if it
 * is the collection subscribed cards are logged in, those too. Deterministic —
 * no timestamp — so it changes only when some card did.
 */
async function snapshot(repo: string): Promise<string> {
  const subscribed = getConfig() !== null && repoKey(getConfig()!) === repo;
  const records = (await getStateRecords())
    .filter((r) => r.group === repo || (subscribed && r.group === SUBSCRIBED_GROUP))
    .sort((a, b) => (a.card < b.card ? -1 : a.card > b.card ? 1 : 0));
  const cards: Record<string, unknown> = {};
  for (const r of records) {
    cards[r.card] = {
      due: r.dueDate,
      s: r.stability,
      d: r.difficulty,
      reps: r.reviewCount,
      last: r.lastReviewedAt,
      lastDay: r.lastDay,
      interval: r.intervalDays,
    };
  }
  return JSON.stringify({ version: 1, options: fingerprint(replayOptions()), cards }, null, 1) + "\n";
}

/**
 * Commit this device's changed files on top of `tip`, as one commit.
 *
 * Returns whether the branch now holds everything this device has — false
 * when there was something to push and `canPush` said not to. Throws
 * `ConflictError` when another device moved the branch first; the caller pulls
 * again and retries.
 */
export async function pushDataBranch(
  config: GitHubConfig,
  tip: BranchTip,
  canPush: boolean
): Promise<boolean> {
  const repo = repoKey(config);
  const files = await ownFiles(repo);
  const pushed = (await getMeta<Record<string, string>>(pushedKey(repo))) ?? {};

  const changes: TreeChange[] = [];
  for (const [path, text] of files) {
    if (pushed[path] !== text) changes.push({ path, content: text });
  }
  // A month whose only grade was undone after it was pushed: the file goes.
  for (const path of Object.keys(pushed)) {
    if (!files.has(path)) changes.push({ path, sha: null });
  }
  if (changes.length === 0) return true;
  if (!canPush) return false;

  changes.push({ path: "snapshot.json", content: await snapshot(repo) });
  const tree = await createTree(config, tip.tree, changes);
  const commit = await createCommit(
    config,
    `Record reviews from ${deviceId()}`,
    tree.sha,
    tip.head ? [tip.head] : []
  );
  if (tip.head) await updateRef(config, DATA_BRANCH, commit);
  else await createRef(config, DATA_BRANCH, commit);

  await setMeta(pushedKey(repo), Object.fromEntries(files));
  // The tip moved by exactly our files, so the next pull has nothing to fetch
  // unless someone else commits.
  await setMeta(tipKey(repo), { head: commit, tree: tree.sha } satisfies BranchTip);
  return true;
}
