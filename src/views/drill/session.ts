import { Card, DrillSession, Grade, Performance, Review } from "../../types";
import { updatePerformance, todayStr, formatInterval } from "../../fsrs";
import {
  getAllPerformances,
  getReviewsSince,
  persistReview,
  revertReview,
  saveSession,
  clearSession,
} from "../../db";
import { getConfig, getIntervalFuzz } from "../../github";
import { recordIntroduced } from "../../new-card-budget";
import { syncStateOnly } from "../../sync";
import { haptic } from "../../haptics";

/**
 * A drill in progress: the queue, the undo stack, and the writes that make each
 * grade durable. Deliberately free of the DOM — everything here is testable
 * without a document, and the view finds out about changes by subscribing.
 */

export type SessionOptions = {
  /** Demo mode: run the whole loop but persist nothing. */
  dryRun?: boolean;
  /** Scheduling state to use instead of reading it from IndexedDB. */
  cache?: Map<string, Performance>;
  /** Restore an interrupted drill instead of starting a fresh one. */
  resume?: DrillSession;
};

export type Session = {
  /** The card on screen, or null once the drill is over. */
  readonly current: Card | null;
  /** The one behind it, which the view typesets ahead of time. */
  readonly next: Card | null;
  readonly revealed: boolean;
  /** The current card is being reinforced, not FSRS-graded. */
  readonly requeued: boolean;
  /** 0 to 1, over the whole session including an earlier sitting. */
  readonly progress: number;
  readonly canUndo: boolean;
  readonly finished: boolean;
  /** A write failed, so this session may not survive the device. */
  readonly writeFailed: boolean;
  /** The card an undo would bring back, so the view can keep it built. */
  readonly undoTarget: string | null;

  reveal(): void;
  grade(grade: Grade): void;
  requeue(again: boolean): void;
  undo(): Promise<void>;
  /** Formatted interval each grade would give the current card. */
  previews(): string[];
  /** Clear the stored position and push review state. */
  close(): Promise<void>;
  /** Every review in this session, for the summary. */
  summary(): Promise<Review[]>;
  /** Called after any change the view needs to reflect. */
  onChange(listener: () => void): void;
};

type UndoEntry =
  | {
      type: "grade";
      cardHash: string;
      grade: Grade;
      /** Scheduling state before the grade, used to reverse the write. */
      prevPerf: Performance;
      /** Key of the persisted review; null until the write lands. */
      reviewKey: IDBValidKey | null;
    }
  | { type: "requeue"; cardHash: string; again: boolean };

/** Fresh drills shuffle and bury cloze siblings; resumed ones keep their order. */
function buildQueue(dueCards: Card[], resume?: DrillSession): Card[] {
  if (resume) {
    const byHash = new Map(dueCards.map((c) => [c.hash, c]));
    return resume.queue
      .map((hash) => byHash.get(hash))
      .filter((c): c is Card => c !== undefined);
  }

  const shuffled = [...dueCards];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Bury cloze siblings: keep only the first card per family hash.
  const seenFamilies = new Set<string>();
  const queue: Card[] = [];
  for (const card of shuffled) {
    if (card.familyHash) {
      if (seenFamilies.has(card.familyHash)) continue;
      seenFamilies.add(card.familyHash);
    }
    queue.push(card);
  }
  return queue;
}

async function buildCache(
  cards: Card[],
  provided?: Map<string, Performance>
): Promise<Map<string, Performance>> {
  const source = provided ?? (await getAllPerformances());
  const cache = new Map<string, Performance>();
  for (const card of cards) {
    if (!cache.has(card.hash)) {
      cache.set(card.hash, source.get(card.hash) ?? { type: "new" });
    }
  }
  return cache;
}

export async function createSession(
  dueCards: Card[],
  options: SessionOptions = {}
): Promise<Session> {
  const { dryRun = false, resume } = options;

  const queue = buildQueue(dueCards, resume);
  const cache = await buildCache(queue, options.cache);

  // Cards never reviewed before, so a grade can be charged against today's
  // new-card budget exactly once.
  const newCardHashes = new Set<string>();
  for (const [hash, perf] of cache) {
    if (perf.type === "new") newCardHashes.add(hash);
  }
  const gradedNewCards = new Set<string>(resume?.gradedNew ?? []);

  // The undo stack is intentionally not persisted: undo is a within-sitting
  // correction, and a resumed drill starts with a clean one.
  const requeuedHashes = new Set<string>(resume?.requeued ?? []);
  const completedHashes = new Set<string>(resume?.completed ?? []);
  const undoStack: UndoEntry[] = [];
  const startedAt = resume?.startedAt ?? new Date().toISOString();
  const totalCards = resume?.totalCards ?? queue.length;

  const reviews: Review[] = [];
  let revealed = false;
  const useFuzz = getIntervalFuzz();

  let listener: (() => void) | null = null;
  const notify = () => listener?.();

  // Grades are persisted as they happen rather than batched until the session
  // ends: a drill interrupted by a crash, a backgrounded tab, or the OS
  // reclaiming the page must keep the reviews already answered. Writes are
  // serialized so an undo can never overtake the grade it reverses.
  let writeChain: Promise<void> = Promise.resolve();
  let writeFailed = false;

  function enqueueWrite(op: () => Promise<void>): Promise<void> {
    writeChain = writeChain.then(op).catch((e) => {
      console.error("Failed to persist review:", e);
      writeFailed = true;
      notify();
    });
    return writeChain;
  }

  /** Current drill position, for persistence. */
  function snapshot(): DrillSession {
    return {
      queue: queue.map((c) => c.hash),
      requeued: [...requeuedHashes],
      completed: [...completedHashes],
      gradedNew: [...gradedNewCards],
      totalCards,
      startedAt,
    };
  }

  function savePosition(): void {
    if (!dryRun) {
      const position = snapshot();
      enqueueWrite(() => saveSession(position));
    }
  }

  // Record the starting position, so a crash before the first grade still
  // resumes this card set rather than reshuffling into a different one.
  savePosition();

  const session: Session = {
    get current() {
      return queue[0] ?? null;
    },
    get next() {
      return queue[1] ?? null;
    },
    get revealed() {
      return revealed;
    },
    get requeued() {
      const card = queue[0];
      return card !== undefined && requeuedHashes.has(card.hash);
    },
    get progress() {
      return totalCards === 0 ? 0 : completedHashes.size / totalCards;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get finished() {
      return queue.length === 0;
    },
    get writeFailed() {
      return writeFailed;
    },
    get undoTarget() {
      return undoStack[undoStack.length - 1]?.cardHash ?? null;
    },

    reveal() {
      if (revealed || queue.length === 0) return;
      revealed = true;
      notify();
    },

    grade(grade: Grade) {
      if (!revealed) return;
      haptic();

      const reviewedAt = new Date().toISOString();
      const card = queue.shift()!;
      const perf = cache.get(card.hash)!;
      const newPerf = updatePerformance(perf, grade, reviewedAt, useFuzz);

      const review: Review = {
        cardHash: card.hash,
        reviewedAt,
        grade,
        stability: newPerf.stability,
        difficulty: newPerf.difficulty,
        intervalRaw: newPerf.intervalRaw,
        intervalDays: newPerf.intervalDays,
        dueDate: newPerf.dueDate,
      };

      cache.set(card.hash, newPerf);

      // Charge the new-card budget only when the card is actually graded —
      // and never in demo mode, which is meant to persist nothing. The budget
      // lives in localStorage, so it counts as persistence.
      if (newCardHashes.has(card.hash) && !gradedNewCards.has(card.hash)) {
        gradedNewCards.add(card.hash);
        if (!dryRun) recordIntroduced(todayStr(), 1);
      }

      // Forgot and Hard go to the back for reinforcement, with no further FSRS.
      if (grade === Grade.Forgot || grade === Grade.Hard) {
        requeuedHashes.add(card.hash);
        queue.push(card);
      } else {
        completedHashes.add(card.hash);
      }

      reviews.push(review);

      const undoEntry: UndoEntry = {
        type: "grade",
        cardHash: card.hash,
        grade,
        prevPerf: perf,
        reviewKey: null,
      };
      undoStack.push(undoEntry);

      if (!dryRun) {
        const position = snapshot();
        enqueueWrite(async () => {
          undoEntry.reviewKey = await persistReview(
            card.hash,
            newPerf,
            review,
            position
          );
        });
      }

      revealed = false;
      notify();
    },

    requeue(again: boolean) {
      if (!revealed) return;
      haptic();

      const card = queue.shift()!;
      undoStack.push({ type: "requeue", cardHash: card.hash, again });

      if (again) {
        queue.push(card);
      } else {
        requeuedHashes.delete(card.hash);
        completedHashes.add(card.hash);
      }

      savePosition();
      revealed = false;
      notify();
    },

    async undo() {
      if (undoStack.length === 0) return;

      const entry = undoStack.pop()!;
      const card = dueCards.find((c) => c.hash === entry.cardHash);
      if (!card) return;

      if (entry.type === "requeue") {
        if (entry.again) {
          // "Again" pushed the card to the back — take it out again.
          const idx = queue.findLastIndex((c) => c.hash === card.hash);
          if (idx >= 0) queue.splice(idx, 1);
        } else {
          // "Got it" retired the card — put it back into reinforcement.
          requeuedHashes.add(card.hash);
          completedHashes.delete(card.hash);
        }
        queue.unshift(card);
        savePosition();
      } else {
        reviews.pop();

        if (entry.grade === Grade.Forgot || entry.grade === Grade.Hard) {
          const idx = queue.findLastIndex((c) => c.hash === card.hash);
          if (idx >= 0) queue.splice(idx, 1);
          requeuedHashes.delete(card.hash);
        } else {
          completedHashes.delete(card.hash);
        }

        // Give back the new-card budget if this was the card's first grade.
        if (gradedNewCards.has(card.hash)) {
          const stillGraded = reviews.some((r) => r.cardHash === card.hash);
          if (!stillGraded) {
            gradedNewCards.delete(card.hash);
            if (!dryRun) recordIntroduced(todayStr(), -1);
          }
        }

        queue.unshift(card);

        // Reverse the persisted write. Writes are serialized, so the grade's
        // write has landed and its key is populated by the time this runs.
        if (!dryRun) {
          const position = snapshot();
          await enqueueWrite(() =>
            revertReview(
              entry.cardHash,
              entry.prevPerf,
              entry.reviewKey,
              position
            )
          );
        }
        cache.set(card.hash, entry.prevPerf);
      }

      revealed = false;
      notify();
    },

    previews() {
      const card = queue[0];
      if (!card) return [];
      const perf = cache.get(card.hash)!;
      const now = new Date().toISOString();
      return [Grade.Forgot, Grade.Hard, Grade.Good, Grade.Easy].map((grade) =>
        formatInterval(updatePerformance(perf, grade, now, false).intervalDays)
      );
    },

    async close() {
      if (dryRun) return;
      enqueueWrite(() => clearSession());
      await writeChain;

      // Every grade is already durable locally, so pushing them to GitHub is
      // not something to hold the user behind on the way out of a drill. It
      // runs behind the deck list, which reports its progress and failures.
      const config = getConfig();
      if (config && navigator.onLine) syncStateOnly(config);
    },

    async summary() {
      if (dryRun) return reviews;
      // Grades are written behind a queue, and the last one is still in flight
      // when the queue empties. Reading before it lands undercounts the
      // session, usually by exactly the card that just finished it.
      await writeChain;
      // From the store rather than from memory, so a session picked up across
      // two sittings reports all of itself.
      return getReviewsSince(startedAt);
    },

    onChange(fn: () => void) {
      listener = fn;
    },
  };

  return session;
}
