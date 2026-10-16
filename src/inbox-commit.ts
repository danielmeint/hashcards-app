import {
  ConflictError,
  RepoConfig,
  TreeChange,
  createCommit,
  createTree,
  deleteFile,
  getBlobText,
  getRef,
  getRepos,
  getTree,
  readFileIfPresent,
  repoKey,
  updateRef,
  writableRepos,
  writeFile,
} from "./github";
import { applyOps } from "./draft-edits";
import { InboxOp, commitMessage, dropOps, pendingOps } from "./inbox-queue";
import { DeckFile, inRepo, updateDeckFiles } from "./db";
import { parseFile } from "./parser";
import { deckNameFor, exclusive, loadCards } from "./sync";
import { gitBlobSha } from "./hash";
import { CONFLICT_RETRIES } from "./compat";
import { AuthError } from "./auth";
import { getSyncStatus, setSyncStatus } from "./sync-state";
import { isDemo } from "./demo-mode";

/**
 * Committing the Inbox's queued changes: one commit per collection, however
 * many files they touch.
 *
 * Through the Git Data API on the content branch, the way `data-branch.ts`
 * writes review data, rather than the contents API `card-edit.ts` uses. The
 * contents API commits one file per request, and agents scatter drafts across
 * every deck they write to: a batch spanning five files would be five commits,
 * which is the noise batching exists to avoid. Here the files are read from
 * one tree, written as one new tree, and committed once.
 *
 * Conflicts are settled the way a card edit settles them — nothing is ever
 * overwritten — but more finely, since a batch is many small changes rather
 * than one file. Each change finds its block afresh in the file as it is now
 * (`applyOps`), so a file that moved elsewhere costs nothing; a change whose
 * draft itself was edited, removed or accepted on GitHub is dropped and
 * reported, and the draft stays as GitHub has it. A commit that loses the race
 * for the branch (the ref update is fast-forward only) is rebuilt on the new
 * tip, as a data-branch push is.
 */

export type CommitOutcome = {
  /** Changes now in the repository. */
  applied: InboxOp[];
  /** Changes refused because their draft changed upstream. */
  conflicts: InboxOp[];
  /** The new commit, or null if there was nothing left to commit. */
  commit: string | null;
};

export async function commitInbox(config: RepoConfig, ops: InboxOp[]): Promise<CommitOutcome> {
  if (isDemo()) return commitToDemo(config, ops);
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptCommit(config, ops);
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= CONFLICT_RETRIES) throw e;
    }
  }
}

async function attemptCommit(config: RepoConfig, ops: InboxOp[]): Promise<CommitOutcome> {
  const head = await getRef(config, config.branch);
  if (!head) throw new Error(`${repoKey(config)} has no branch '${config.branch}' to commit to.`);
  const tree = await getTree(config, head);

  // In queue order within each file: an edit and then a keep of the edited
  // block only make sense that way round.
  const byPath = new Map<string, InboxOp[]>();
  for (const op of ops) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);

  const applied: InboxOp[] = [];
  const conflicts: InboxOp[] = [];
  const changes: TreeChange[] = [];
  const written = new Map<string, string | null>();
  for (const [path, fileOps] of byPath) {
    const entry = tree.entries.find((e) => e.path === path && e.type === "blob");
    if (!entry) {
      // The file was deleted or moved upstream: its drafts went with it.
      conflicts.push(...fileOps);
      continue;
    }
    const result = await applyOps(await getBlobText(config, entry.sha), path, fileOps);
    applied.push(...result.applied);
    conflicts.push(...result.conflicts);
    if (result.applied.length === 0) continue;
    // A deck with nothing left in it goes, as it does when the card editor
    // deletes its last card.
    const gone = result.text.trim() === "";
    changes.push(gone ? { path, sha: null } : { path, content: result.text });
    written.set(path, gone ? null : result.text);
  }

  if (changes.length === 0) return { applied, conflicts, commit: null };
  const created = await createTree(config, tree.sha, changes);
  const commit = await createCommit(config, commitMessage(applied), created.sha, [head]);
  await updateRef(config, config.branch, commit);
  await recordFiles(repoKey(config), written, created.blobs);
  return { applied, conflicts, commit };
}

/**
 * The same batch, applied to the demo's in-memory repository. There is no Git
 * Data API there, only files, so each changed file is written on its own —
 * but through `applyOps`, the same as above, so a kept, discarded or edited
 * draft comes out exactly as it would in a real repo.
 */
async function commitToDemo(config: RepoConfig, ops: InboxOp[]): Promise<CommitOutcome> {
  const byPath = new Map<string, InboxOp[]>();
  for (const op of ops) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);
  const applied: InboxOp[] = [];
  const conflicts: InboxOp[] = [];
  const written = new Map<string, string | null>();
  const blobs = new Map<string, string>();
  for (const [path, fileOps] of byPath) {
    const file = await readFileIfPresent(config, path);
    if (!file) {
      conflicts.push(...fileOps);
      continue;
    }
    const result = await applyOps(file.text, path, fileOps);
    applied.push(...result.applied);
    conflicts.push(...result.conflicts);
    if (result.applied.length === 0) continue;
    if (result.text.trim() === "") {
      await deleteFile(config, path, file.sha, commitMessage(result.applied));
      written.set(path, null);
    } else {
      blobs.set(path, await writeFile(config, path, result.text, { sha: file.sha, message: commitMessage(result.applied) }));
      written.set(path, result.text);
    }
  }
  await recordFiles(repoKey(config), written, blobs);
  return { applied, conflicts, commit: applied.length > 0 ? "demo" : null };
}

/**
 * Put what was committed into the deck store, under the blob SHA GitHub will
 * list it with, so the next sync sees files it already has rather than
 * fetching back the bytes it just sent.
 */
async function recordFiles(
  repo: string,
  written: Map<string, string | null>,
  blobs: Map<string, string>
): Promise<void> {
  const updated: DeckFile[] = [];
  const removed: { repo: string; path: string }[] = [];
  for (const [path, text] of written) {
    if (text === null) {
      removed.push({ repo, path });
      continue;
    }
    // GitHub's answer lists only the top level of the tree, so a deck in a
    // folder is not in it; the SHA is git's own, and cheap to work out.
    const sha = blobs.get(path) ?? (await gitBlobSha(text));
    let cards: DeckFile["cards"] = [];
    try {
      cards = inRepo(await parseFile(text, path, deckNameFor(path)), repo);
    } catch (e) {
      // `applyOps` parsed it already; recorded empty, as sync records a file
      // it cannot read, rather than left stale.
      console.warn(`Failed to parse ${path}:`, e);
    }
    updated.push({ repo, path, sha, cards });
  }
  await updateDeckFiles(updated, removed);
}

export type FlushResult = { committed: number; conflicts: number };

/**
 * Commit every collection's queued changes. For a caller already holding the
 * repository (the sync runner); anyone else goes through `flushInbox`.
 */
export async function runInboxFlush(repos: RepoConfig[] = writableRepos()): Promise<FlushResult> {
  const ops = await pendingOps();
  if (ops.length === 0) return { committed: 0, conflicts: 0 };

  let committed = 0;
  let conflicts = 0;
  // A collection removed since, or made a subscription, can never take these.
  const configured = new Set(writableRepos().map(repoKey));
  const orphaned = ops.filter((op) => !configured.has(op.repo));
  if (orphaned.length > 0) await dropOps(orphaned.map((op) => op.id));

  for (const repo of repos) {
    if (repo.readOnly) continue;
    const mine = ops.filter((op) => op.repo === repoKey(repo));
    if (mine.length === 0) continue;
    const outcome = await commitInbox(repo, mine);
    await dropOps([...outcome.applied, ...outcome.conflicts].map((op) => op.id));
    committed += outcome.applied.length;
    conflicts += outcome.conflicts.length;
  }
  await loadCards();
  return { committed, conflicts };
}

/** Queued behind any sync or edit in progress, since it writes the repo and the deck store. */
export function flushInbox(): Promise<FlushResult> {
  return exclusive(() => runInboxFlush());
}

/** What to tell someone whose changes were refused, or nothing. */
export function conflictNotice(conflicts: number): string | undefined {
  if (conflicts === 0) return undefined;
  return conflicts === 1
    ? "One Inbox change was not saved: that draft changed on GitHub."
    : `${conflicts} Inbox changes were not saved: those drafts changed on GitHub.`;
}

/**
 * Commit the queue in the background, reporting through the sync status as a
 * sync does — so Today's dot and banner say "saving", then either nothing or
 * what went wrong, and repaint the counts when it lands. Offline is not a
 * failure: the queue waits, and the banner says so.
 */
export async function saveInbox(): Promise<void> {
  // The demo's repository is in memory: being offline does not keep it away.
  if ((!navigator.onLine && !isDemo()) || getRepos().length === 0) return;
  if ((await pendingOps()).length === 0) return;
  const before = getSyncStatus();
  setSyncStatus({ phase: "syncing", detail: "Saving Inbox" });
  try {
    const result = await flushInbox();
    const notice = conflictNotice(result.conflicts) ?? (before.phase === "idle" ? before.notice : undefined);
    setSyncStatus(notice ? { phase: "idle", notice } : { phase: "idle" });
  } catch (e) {
    setSyncStatus({
      phase: "error",
      message: (e as Error).message,
      needsSignIn: e instanceof AuthError,
    });
  }
}
