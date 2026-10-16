import { Card, ParsedCard } from "./types";
import { FileOp } from "./draft-edits";
import { getMeta, inRepo, setMeta } from "./db";

/**
 * The Inbox's changes that have not reached GitHub yet.
 *
 * Curating drafts is quick — a swipe each — and a commit per swipe would turn
 * a card repo's history into noise. So a decision is queued here, in
 * IndexedDB, and committed with the others in one commit per collection
 * (`inbox-commit.ts`) when you leave the Inbox, after a pause, or on the next
 * sync. Queued is durable: closing the app, or having no connection, loses
 * nothing.
 *
 * Until then the app behaves as if they had landed. `applyPending` lays the
 * queue over the cards every time they are read (`loadCards`), so a kept card
 * is a new card at once — under the key it will have, since the ID it will be
 * given is decided when it is kept — and a discarded one is gone.
 */

export type InboxOp = FileOp & {
  /** Identifies the op in the queue, for undo and for removing it once committed. */
  id: string;
  repo: string;
  path: string;
  /** edit: what the rewritten block parses into, laid over the cards until it is committed. */
  cards?: ParsedCard[];
  /** When it was queued: how long a change has been waiting, for the sync notice. */
  at: string;
};

const QUEUE_KEY = "inbox_queue";

export async function pendingOps(): Promise<InboxOp[]> {
  return (await getMeta<InboxOp[]>(QUEUE_KEY)) ?? [];
}

export async function enqueue(ops: InboxOp[]): Promise<void> {
  await setMeta(QUEUE_KEY, [...(await pendingOps()), ...ops]);
}

/**
 * Take ops out of the queue by ID: committed, refused, or undone. By ID rather
 * than "everything", because a decision made while a commit was in flight is
 * still owed.
 */
export async function dropOps(ids: Iterable<string>): Promise<void> {
  const gone = new Set(ids);
  await setMeta(
    QUEUE_KEY,
    (await pendingOps()).filter((op) => !gone.has(op.id))
  );
}

/** A fresh op ID. Only ever compared for equality, on one device. */
export function opId(): string {
  return crypto.randomUUID();
}

/**
 * `cards` as they will be once `ops` are committed. Pure, and applied in queue
 * order, so an edit followed by a keep of the edited block works out the same
 * here as it will in the file. An op whose block is not among the cards any
 * more (the file changed under it) is skipped here; the commit will report it.
 */
export function applyPending(cards: Card[], ops: InboxOp[]): Card[] {
  let result = cards;
  for (const op of ops) {
    const inBlock = (c: Card) =>
      c.repo === op.repo && c.filePath === op.path && op.block.includes(c.hash);
    const first = result.findIndex(inBlock);
    if (first === -1) continue;
    const rest = result.filter((c) => !inBlock(c));
    if (op.action === "discard") {
      result = rest;
    } else if (op.action === "edit") {
      const replaced = inRepo(op.cards ?? [], op.repo);
      result = [...rest.slice(0, first), ...replaced, ...rest.slice(first)];
    } else {
      result = result.map((c) => (inBlock(c) ? { ...c, status: "active" } : c));
    }
  }
  return result;
}

/**
 * "Inbox: keep 4, discard 2" — what a batch did, for its commit message. In a
 * fixed order rather than the order things happened, so two batches doing the
 * same read the same.
 */
export function commitMessage(ops: Pick<InboxOp, "action">[]): string {
  const count = (action: InboxOp["action"]) => ops.filter((op) => op.action === action).length;
  const parts = (["keep", "discard", "edit"] as const)
    .filter((action) => count(action) > 0)
    .map((action) => `${action} ${count(action)}`);
  return `Inbox: ${parts.join(", ")}`;
}

/**
 * When to commit while the Inbox is open: after `delay` with nothing new
 * decided, so a run of swipes becomes one commit rather than one each, and
 * the last of them is still there to undo for a moment. `now()` is leaving:
 * commit straight away.
 */
export type Batcher = {
  /** Something was just queued: start (or restart) the wait. */
  touch(): void;
  /** Commit now, cancelling the wait. */
  now(): Promise<void>;
  /** Stop waiting without committing. */
  cancel(): void;
};

export function createBatcher(delay: number, flush: () => Promise<void>): Batcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    touch() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
    },
    now() {
      cancel();
      return flush();
    },
    cancel,
  };
}
