import { Card, DrillSession, Grade, Performance, Review } from "../../types";
import { utcOffsetMinutes } from "../../core/schedule";
import { updatePerformance, todayStr, formatInterval, localDay } from "../../fsrs";
import {
  PersistedReview,
  StateRecord,
  getAllPerformances,
  getReviewsSince,
  persistReview,
  revertReview,
  saveSession,
  clearSession,
  stateKey,
} from "../../db";
import { CardState, applyEvent, compareOrder, orderOf } from "../../core/replay";
import { ReviewEvent } from "../../core/events";
import { logTarget } from "../../review-log";
import { getConfig, getDesiredRetention, getIntervalFuzz } from "../../github";
import { recordIntroduced } from "../../new-card-budget";
import { syncStateOnly } from "../../sync";
import { haptic } from "../../haptics";

/**
 * A drill in progress: the queue, the undo stack, and the writes that make each
 * grade durable. Deliberately free of the DOM — everything here is testable
 * without a document, and the view finds out about changes by subscribing.
 */

export type SessionOptions = {
  /**
   * Run the whole loop but persist nothing. The old drill-only demo used it;
   * the demo now runs on a store of its own (`demo-mode.ts`) and persists as
   * the app does, so this is left for tests.
   */
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
  /** 0 to 1, over the whole session including an earlier sitting. */
  readonly progress: number;
  /** Cards answered for good, and how many the session holds, for "n / total". */
  readonly done: number;
  readonly total: number;
  /** Whether the card on screen has never been reviewed. */
  readonly currentIsNew: boolean;
  readonly canUndo: boolean;
  readonly finished: boolean;
  /** A write failed, so this session may not survive the device. */
  readonly writeFailed: boolean;
  /**
   * The content hash of the card an undo would bring back, so the view can
   * keep it built. A hash rather than a key because what the view caches is
   * rendered content, and an edit changes that without changing the key.
   */
  readonly undoTarget: string | null;

  reveal(): void;
  grade(grade: Grade): void;
  undo(): Promise<void>;
  /**
   * Put what an edit made of a card (the one whose content hash was `from`)
   * where the old one was, or drop it if the edit deleted it. `keptScheduling`
   * says whether the old card's history followed it to a new key; when it did
   * not, this is a card nothing has ever seen, and the intervals it offers
   * have to say so. A card that kept its key (it has an ID) keeps its history
   * whatever this says.
   */
  replaceCard(from: string, to: Card | null, keptScheduling: boolean): void;
  /** Formatted interval each grade would give the current card. */
  previews(): string[];
  /** Clear the stored position and push review state. */
  close(): Promise<void>;
  /** Every review in this session, for the summary. */
  summary(): Promise<Review[]>;
  /** Called after any change the view needs to reflect. */
  onChange(listener: () => void): void;
};

type UndoEntry = {
  /** The card's `stateKey`. */
  key: string;
  /** Its replay group, whose mark the write may have moved. */
  group: string;
  grade: Grade;
  /** Scheduling state before the grade, used to reverse the write. */
  prevPerf: Performance;
  /** What the write changed; null until it lands. */
  persisted: PersistedReview | null;
};

/**
 * The state a card was in before a grade, as `applyEvent` takes it. A state
 * from the cache already is one; anything else (a test's) is
 * filled in the way the live path always read it, in this device's days.
 */
function asCardState(perf: Performance): CardState | undefined {
  if (perf.type === "new") return undefined;
  const state = perf as Partial<CardState> & typeof perf;
  return {
    ...perf,
    lastDay: state.lastDay ?? localDay(new Date(perf.lastReviewedAt)),
    lastGrade: state.lastGrade ?? null,
  };
}

/** Cards that bury each other: a block's cloze deletions, a card and its reverse. */
function familyOf(card: Card): string | null {
  // Older cached cards have none until their file is parsed again.
  return card.familyHash ? `${card.repo}/${card.familyHash}` : null;
}

/** Fresh drills shuffle and bury siblings; resumed ones keep their order. */
function buildQueue(dueCards: Card[], resume?: DrillSession): Card[] {
  if (resume) {
    const byKey = new Map(dueCards.map((c) => [stateKey(c), c]));
    return resume.queue
      .map((key) => byKey.get(key))
      .filter((c): c is Card => c !== undefined);
  }

  const shuffled = [...dueCards];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Bury siblings: keep only the first card per family.
  const seenFamilies = new Set<string>();
  const queue: Card[] = [];
  for (const card of shuffled) {
    const family = familyOf(card);
    if (family) {
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
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
    const key = stateKey(card);
    if (!cache.has(key)) cache.set(key, source.get(key) ?? { type: "new" });
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

  /**
   * Every card this session can reach, by key — including ones already
   * retired, which undo has to be able to bring back. A map rather than a
   * search through `dueCards` because an edit can change a card (and an ID-less
   * card's key) mid-drill, and the array the drill was started with cannot be
   * told about that.
   */
  const known = new Map(dueCards.map((c) => [stateKey(c), c]));

  // Cards never reviewed before, so a grade can be charged against today's
  // new-card budget exactly once.
  const newCardHashes = new Set<string>();
  for (const [key, perf] of cache) {
    if (perf.type === "new") newCardHashes.add(key);
  }
  const gradedNewCards = new Set<string>(resume?.gradedNew ?? []);

  // The undo stack is intentionally not persisted: undo is a within-sitting
  // correction, and a resumed drill starts with a clean one.
  const completedHashes = new Set<string>(resume?.completed ?? []);
  const undoStack: UndoEntry[] = [];
  const startedAt = resume?.startedAt ?? new Date().toISOString();
  let totalCards = resume?.totalCards ?? queue.length;

  const reviews: Review[] = [];
  let revealed = false;
  /** The card on screen and since when, for each review's duration. */
  let shown: { key: string; at: number } | null = null;
  const useFuzz = getIntervalFuzz();
  // Read once, like fuzz: a session schedules every card it grades the same way.
  const retention = getDesiredRetention();

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
      queue: queue.map(stateKey),
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
      const card = queue[0] ?? null;
      // The first time the view asks for a card is when it goes on screen,
      // which is where the time spent on it starts.
      if (card && shown?.key !== stateKey(card)) shown = { key: stateKey(card), at: Date.now() };
      return card;
    },
    get next() {
      return queue[1] ?? null;
    },
    get revealed() {
      return revealed;
    },
    get progress() {
      return totalCards === 0 ? 0 : completedHashes.size / totalCards;
    },
    get done() {
      return completedHashes.size;
    },
    get total() {
      return totalCards;
    },
    get currentIsNew() {
      const card = queue[0];
      return card !== undefined && cache.get(card.hash)?.type === "new";
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
      const entry = undoStack[undoStack.length - 1];
      return entry ? known.get(entry.key)?.hash ?? null : null;
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
      const key = stateKey(card);
      const target = logTarget(card);
      const perf = cache.get(key)!;
      // The grade is the event this device will push. Its state comes from
      // replay's own step, keyed as the log keys it, in this device's zone as
      // recorded on the event — so a replay anywhere later gives the same.
      const tz = utcOffsetMinutes(reviewedAt);
      const durationMs = shown?.key === key ? Date.now() - shown.at : undefined;
      const event: ReviewEvent = {
        v: 2,
        kind: "review",
        card: target.card,
        at: reviewedAt,
        tz,
        grade,
        ...(durationMs !== undefined ? { ms: durationMs } : {}),
      };
      const newPerf: StateRecord = {
        ...applyEvent(asCardState(perf), event, { retention, fuzz: useFuzz }),
        key,
        group: target.group,
        card: target.card,
      };

      const review: Review = {
        key,
        log: target.log,
        tz,
        cardHash: card.hash,
        reviewedAt,
        grade,
        stability: newPerf.stability,
        difficulty: newPerf.difficulty,
        intervalRaw: newPerf.intervalRaw,
        intervalDays: newPerf.intervalDays,
        dueDate: newPerf.dueDate,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };

      cache.set(key, newPerf);

      // Charge the new-card budget only when the card is actually graded —
      // and never in a dry run, which is meant to persist nothing. The budget
      // lives in localStorage, so it counts as persistence.
      if (newCardHashes.has(key) && !gradedNewCards.has(key)) {
        gradedNewCards.add(key);
        if (!dryRun) recordIntroduced(todayStr(), 1);
      }

      // Forgot and Hard come round again later in the drill — hashcards' version
      // of Anki's learning steps, since a whole-day schedule cannot say "in ten
      // minutes". The next answer is an ordinary grade: FSRS-6 models a review
      // on the same day, so it counts, rather than being a separate
      // "reinforcement" mode the scheduler never saw.
      if (grade === Grade.Forgot || grade === Grade.Hard) {
        queue.push(card);
      } else {
        completedHashes.add(key);
      }

      reviews.push(review);

      const undoEntry: UndoEntry = {
        key,
        group: target.group,
        grade,
        prevPerf: perf,
        persisted: null,
      };
      undoStack.push(undoEntry);

      if (!dryRun) {
        const position = snapshot();
        enqueueWrite(async () => {
          undoEntry.persisted = await persistReview(
            review,
            newPerf,
            orderOf(event),
            position,
            compareOrder
          );
        });
      }

      revealed = false;
      notify();
    },

    async undo() {
      if (undoStack.length === 0) return;

      const entry = undoStack.pop()!;
      const card = known.get(entry.key);
      if (!card) return;
      const key = entry.key;

      reviews.pop();

      if (entry.grade === Grade.Forgot || entry.grade === Grade.Hard) {
        const idx = queue.findLastIndex((c) => stateKey(c) === key);
        if (idx >= 0) queue.splice(idx, 1);
      } else {
        completedHashes.delete(key);
      }

      // Give back the new-card budget if this was the card's first grade.
      if (gradedNewCards.has(key)) {
        const stillGraded = reviews.some((r) => r.key === key);
        if (!stillGraded) {
          gradedNewCards.delete(key);
          if (!dryRun) recordIntroduced(todayStr(), -1);
        }
      }

      queue.unshift(card);

      // Reverse the persisted write. Writes are serialized, so the grade's
      // write has landed and `persisted` is filled in by the time this runs.
      if (!dryRun) {
        const position = snapshot();
        const prev = entry.prevPerf;
        const prevState =
          prev.type === "new"
            ? null
            : ({ key, group: entry.group, card: key, ...asCardState(prev)!, ...prev } as StateRecord);
        await enqueueWrite(() =>
          revertReview(key, entry.group, prevState, entry.persisted, position)
        );
      }
      cache.set(key, entry.prevPerf);

      revealed = false;
      notify();
    },

    replaceCard(fromHash: string, to: Card | null, keptScheduling: boolean) {
      const at = queue.findIndex((c) => c.hash === fromHash);
      if (at === -1) return;
      // An edit that only moved whitespace the parser trims produces the same
      // card back. Nothing to substitute, and unpicking the undo stack for it
      // would be throwing away history for no change at all.
      if (to !== null && to.hash === fromHash) return;
      const from = stateKey(queue[at]);
      const toKey = to === null ? null : stateKey(to);

      // Grades already given to the old text stand — they happened, and the
      // review log has them. What cannot stand is undoing one: reversing a
      // grade means writing the card's earlier scheduling back, and after an
      // edit that scheduling may belong to a different card. The entries go,
      // and the reviews that pair with them go with them, so the stack and the
      // list stay the parallel things the rest of undo assumes.
      for (let i = undoStack.length - 1; i >= 0; i--) {
        if (undoStack[i].key === from) undoStack.splice(i, 1);
      }
      for (let i = reviews.length - 1; i >= 0; i--) {
        if (reviews[i].key === from) reviews.splice(i, 1);
      }

      if (to === null || toKey === null) {
        queue.splice(at, 1);
        // The progress bar counts completions against the size of the queue;
        // a card that left without being answered has to leave the denominator
        // too, or the bar can never fill.
        if (!completedHashes.has(from)) totalCards = Math.max(0, totalCards - 1);
      } else {
        queue[at] = to;
        known.set(toKey, to);
        // The same key is the same card (it has an ID): its history is its
        // own, whatever the editor was asked. A new key is a card that kept
        // the old one's history only if the edit carried it.
        if (toKey === from) {
          savePosition();
          revealed = false;
          notify();
          return;
        }
        const perf: Performance = keptScheduling
          ? cache.get(from) ?? { type: "new" }
          : { type: "new" };
        cache.set(toKey, perf);
        if (perf.type === "new") newCardHashes.add(toKey);

        for (const set of [completedHashes, gradedNewCards]) {
          if (set.delete(from)) set.add(toKey);
        }
      }

      known.delete(from);
      cache.delete(from);
      newCardHashes.delete(from);
      completedHashes.delete(from);
      gradedNewCards.delete(from);

      savePosition();
      revealed = false;
      notify();
    },

    previews() {
      const card = queue[0];
      if (!card) return [];
      const perf = cache.get(stateKey(card))!;
      const now = new Date().toISOString();
      return [Grade.Forgot, Grade.Hard, Grade.Good, Grade.Easy].map((grade) =>
        formatInterval(
          updatePerformance(perf, grade, now, { retention }).intervalDays
        )
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
