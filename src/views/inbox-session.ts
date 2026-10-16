import { DraftBlock, blockHashes } from "../draft-edits";
import { InboxOp } from "../inbox-queue";

/**
 * One visit to the Inbox: the drafts in front of you, what you decided about
 * each, and the undo for the last decision.
 *
 * Kept apart from the view, and from IndexedDB, by `deps` — so the rules
 * (what each decision queues, what an undo takes back) are testable without a
 * DOM or a database.
 */

export type Decision = "keep" | "discard" | "edit" | "skip";

export type InboxDeps = {
  /** Queue these decisions (and make the cards reflect them). */
  enqueue(ops: InboxOp[]): Promise<void>;
  /** Take queued decisions back out. */
  drop(ids: string[]): Promise<void>;
  /** A fresh op ID. */
  newOpId(): string;
  /** The time, for `InboxOp.at`. */
  now(): string;
};

/** A decision, and what undoing it has to restore. */
type Entry = {
  decision: Decision;
  /** The draft as it was before the decision. */
  item: DraftBlock;
  ops: InboxOp[];
  /** Whether it took the draft off the front of the queue (all but an edit that left it a draft). */
  advanced: boolean;
};

export type InboxSession = {
  readonly current: DraftBlock | null;
  /** Drafts dealt with or skipped, and how many there were. */
  readonly done: number;
  readonly total: number;
  readonly finished: boolean;
  readonly canUndo: boolean;
  /** How many of each decision this visit, for the summary. Undone ones don't count. */
  counts(): Record<Decision, number>;
  keep(): Promise<void>;
  discard(): Promise<void>;
  skip(): void;
  /**
   * The current draft rewritten in the editor: `op` is the queued rewrite,
   * `next` the block it became — null if the rewrite emptied it, and a block
   * that is no longer a draft if the rewrite took its Status line out.
   */
  edit(op: InboxOp, next: DraftBlock | null): Promise<void>;
  undo(): Promise<void>;
  /**
   * Some decisions were committed: they can't be undone from here any more.
   * `pending` is what is still queued.
   */
  committed(pending: Set<string>): void;
  onChange(listener: () => void): void;
};

export function createInboxSession(drafts: DraftBlock[], deps: InboxDeps): InboxSession {
  const queue = [...drafts];
  const total = drafts.length;
  let history: Entry[] = [];
  /** Kept apart from `history`, which forgets what has been committed. */
  const tally: Record<Decision, number> = { keep: 0, discard: 0, edit: 0, skip: 0 };
  const record = (entry: Entry) => {
    history.push(entry);
    tally[entry.decision]++;
  };
  let busy = false;
  const listeners: (() => void)[] = [];
  const changed = () => listeners.forEach((l) => l());

  /** Run one decision at a time: a double tap must not keep the next card too. */
  async function exclusive(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
      changed();
    }
  }

  function op(item: DraftBlock, action: InboxOp["action"], extra: Partial<InboxOp> = {}): InboxOp {
    return {
      id: deps.newOpId(),
      repo: item.repo,
      path: item.path,
      action,
      block: blockHashes(item),
      at: deps.now(),
      ...extra,
    };
  }

  async function decide(decision: "keep" | "discard"): Promise<void> {
    await exclusive(async () => {
      const item = queue[0];
      if (!item) return;
      const queued = op(item, decision);
      await deps.enqueue([queued]);
      queue.shift();
      record({ decision, item, ops: [queued], advanced: true });
    });
  }

  const session: InboxSession = {
    get current() {
      return queue[0] ?? null;
    },
    get done() {
      return total - queue.length;
    },
    total,
    get finished() {
      return queue.length === 0;
    },
    get canUndo() {
      return history.length > 0;
    },
    counts() {
      return { ...tally };
    },
    keep: () => decide("keep"),
    discard: () => decide("discard"),
    skip() {
      // Through the same gate as the rest: a skip landing while a keep is
      // still being queued would take the card after it, not this one.
      void exclusive(async () => {
        const item = queue.shift();
        if (!item) return;
        // Skipped is not lost: it is still a draft, and it is there next time.
        record({ decision: "skip", item, ops: [], advanced: true });
      });
    },
    async edit(queued, next) {
      await exclusive(async () => {
        const item = queue[0];
        if (!item) return;
        await deps.enqueue([queued]);
        // Still a draft: it stays in front of you, rewritten, to keep or not.
        const stillDraft = next !== null && next.cards.every((c) => c.status === "draft");
        if (stillDraft) queue[0] = next!;
        else queue.shift();
        record({ decision: "edit", item, ops: [queued], advanced: !stillDraft });
      });
    },
    async undo() {
      await exclusive(async () => {
        const entry = history.pop();
        if (!entry) return;
        tally[entry.decision]--;
        if (entry.ops.length > 0) await deps.drop(entry.ops.map((o) => o.id));
        if (entry.advanced) queue.unshift(entry.item);
        else queue[0] = entry.item;
      });
    },
    committed(pending) {
      // Undo walks back from the end, so once one decision has gone to GitHub
      // nothing before it can be undone either.
      let keepFrom = 0;
      history.forEach((entry, i) => {
        if (entry.ops.some((o) => !pending.has(o.id))) keepFrom = i + 1;
      });
      if (keepFrom > 0) {
        // Skips have nothing to commit, but undoing one now would put a card
        // back in front of decisions that can no longer be taken back.
        history = history.slice(keepFrom);
        changed();
      }
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
  return session;
}
