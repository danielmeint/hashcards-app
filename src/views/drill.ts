import { Card, DrillSession, Grade, Performance, Review } from "../types";
import { updatePerformance, todayStr, formatInterval } from "../fsrs";
import {
  getAllPerformances,
  getReviewsSince,
  persistReview,
  revertReview,
  saveSession,
  clearSession,
} from "../db";
import { renderCardBody, postRender } from "../render";
import { getConfig, getIntervalFuzz, getHapticFeedback } from "../github";
import { recordIntroduced } from "../new-card-budget";
import { syncStateOnly } from "../sync";

type SessionState = {
  queue: Card[];
  reviews: Review[];
  cache: Map<string, Performance>;
  revealed: boolean;
  totalCards: number;
};

type DrillOptions = {
  dryRun?: boolean;
  cache?: Map<string, Performance>;
  /** Restore an interrupted drill instead of starting a fresh one. */
  resume?: DrillSession;
};

export async function renderDrill(
  container: HTMLElement,
  dueCards: Card[],
  onEnd: () => void,
  options: DrillOptions = {}
): Promise<void> {
  // A resumed drill keeps its original order, burial decisions and progress; a
  // fresh one shuffles and buries cloze siblings.
  const resume = options.resume;
  let filtered: Card[];

  if (resume) {
    const byHash = new Map(dueCards.map((c) => [c.hash, c]));
    filtered = resume.queue
      .map((hash) => byHash.get(hash))
      .filter((c): c is Card => c !== undefined);
  } else {
    const queue = [...dueCards];
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    // Bury cloze siblings: keep only first card per family hash
    const seenFamilies = new Set<string>();
    filtered = [];
    for (const card of queue) {
      if (card.familyHash) {
        if (seenFamilies.has(card.familyHash)) continue;
        seenFamilies.add(card.familyHash);
      }
      filtered.push(card);
    }
  }

  // Populate cache from provided data or IndexedDB
  const cache = new Map<string, Performance>();
  if (options.cache) {
    for (const card of filtered) {
      if (!cache.has(card.hash)) {
        cache.set(card.hash, options.cache.get(card.hash) ?? { type: "new" });
      }
    }
  } else {
    const allPerfs = await getAllPerformances();
    for (const card of filtered) {
      if (!cache.has(card.hash)) {
        cache.set(card.hash, allPerfs.get(card.hash) ?? { type: "new" });
      }
    }
  }

  // Track which cards are new (never reviewed before)
  const newCardHashes = new Set<string>();
  for (const [hash, perf] of cache) {
    if (perf.type === "new") newCardHashes.add(hash);
  }
  const gradedNewCards = new Set<string>(resume?.gradedNew ?? []);

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

  // The undo stack is intentionally not persisted: undo is a within-sitting
  // correction, and a resumed drill starts with a clean one.
  const requeuedHashes = new Set<string>(resume?.requeued ?? []);
  const completedHashes = new Set<string>(resume?.completed ?? []);
  const undoStack: UndoEntry[] = [];
  const startedAt = resume?.startedAt ?? new Date().toISOString();

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
      if (ui) ui.writeError.hidden = false;
    });
    return writeChain;
  }

  const state: SessionState = {
    queue: filtered,
    reviews: [],
    cache,
    revealed: false,
    totalCards: resume?.totalCards ?? filtered.length,
  };

  /** Current drill position, for persistence. */
  function snapshot(): DrillSession {
    return {
      queue: state.queue.map((c) => c.hash),
      requeued: [...requeuedHashes],
      completed: [...completedHashes],
      gradedNew: [...gradedNewCards],
      totalCards: state.totalCards,
      startedAt,
    };
  }

  // Record the starting position, so a crash before the first grade still
  // resumes this card set rather than reshuffling into a different one.
  if (!options.dryRun) {
    enqueueWrite(() => saveSession(snapshot()));
  }

  /**
   * The drill chrome is built once and then mutated. Reveal is a class toggle,
   * advancing swaps a prepared node into place, and the next card is typeset
   * while the current one is on screen — so no interaction re-parses markdown
   * or re-runs KaTeX and highlight.js over content that has not changed.
   */
  type DrillUi = {
    progressFill: HTMLElement;
    writeError: HTMLElement;
    cardContainer: HTMLElement;
    swipeHint: HTMLElement;
    controls: HTMLElement;
    undoBtn: HTMLButtonElement;
    revealBtn: HTMLButtonElement;
    grades: HTMLElement;
    previews: HTMLElement[];
    requeueGrades: HTMLElement;
  };

  let ui: DrillUi | null = null;

  function mountShell(): DrillUi {
    const root = document.createElement("div");
    root.className = "root";
    root.innerHTML = `
      <div class="header">
        <div class="progress-bar">
          <div class="progress-fill"></div>
        </div>
        <div class="write-error" role="alert" hidden>Couldn't save progress on this device — reviews from this session may be lost.</div>
      </div>
      <div class="card-container">
        <div class="swipe-hint" aria-hidden="true" hidden></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <button id="undo-btn" class="btn" disabled>Undo</button>
          <button id="reveal-btn" class="btn">Reveal</button>
          <div class="grades" hidden>
            <button class="btn grade-btn" data-grade="1">Forgot<span class="interval-preview"></span></button>
            <button class="btn grade-btn" data-grade="2">Hard<span class="interval-preview"></span></button>
            <button class="btn grade-btn" data-grade="3">Good<span class="interval-preview"></span></button>
            <button class="btn grade-btn" data-grade="4">Easy<span class="interval-preview"></span></button>
          </div>
          <div class="grades requeue-grades" hidden>
            <button class="btn requeue-btn" data-action="again">Again</button>
            <button class="btn requeue-btn" data-action="done">Got it</button>
          </div>
          <button id="end-btn" class="btn">End</button>
        </div>
      </div>
    `;
    container.replaceChildren(root);

    const pick = <T extends HTMLElement>(selector: string) =>
      root.querySelector(selector) as T;

    const mounted: DrillUi = {
      progressFill: pick(".progress-fill"),
      writeError: pick(".write-error"),
      cardContainer: pick(".card-container"),
      swipeHint: pick(".swipe-hint"),
      controls: pick(".controls"),
      undoBtn: pick<HTMLButtonElement>("#undo-btn"),
      revealBtn: pick<HTMLButtonElement>("#reveal-btn"),
      grades: pick(".grades:not(.requeue-grades)"),
      previews: [
        ...root.querySelectorAll<HTMLElement>(
          ".grades:not(.requeue-grades) .interval-preview"
        ),
      ],
      requeueGrades: pick(".requeue-grades"),
    };

    // Bound once, to nodes that live for the whole drill.
    mounted.revealBtn.addEventListener("click", () => doReveal());
    mounted.undoBtn.addEventListener("click", () => doUndo());
    pick("#end-btn").addEventListener("click", () => doEnd());

    mounted.grades.querySelectorAll(".grade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        doGrade(parseInt((btn as HTMLElement).dataset.grade!) as Grade);
      });
    });

    mounted.requeueGrades.querySelectorAll(".requeue-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        doRequeue((btn as HTMLElement).dataset.action === "again");
      });
    });

    attachCardGestures(mounted);

    mounted.writeError.hidden = !writeFailed;
    return mounted;
  }

  /**
   * Touch input for the card itself. On a phone the controls are a row of small
   * targets along the bottom edge while the card is the whole screen, so the
   * card takes the two gestures worth having: tap to reveal, and swipe to give
   * the two grades that account for most answers. The button row stays for the
   * rest, and nothing here exists on desktop, where the keyboard is better.
   */

  /** How far a drag must travel horizontally before it counts as a swipe. */
  const SWIPE_CLAIM_PX = 12;
  /** How far it must travel before releasing commits, rather than springing back. */
  const SWIPE_COMMIT_PX = 90;

  type Drag = {
    id: number;
    x0: number;
    y0: number;
    dx: number;
    /** Set once the gesture is unambiguously horizontal and we own it. */
    claimed: boolean;
    /** Set once it has passed the commit distance, for a single haptic tick. */
    armed: boolean;
  };

  let drag: Drag | null = null;
  /** A completed swipe also produces a click; that click is not a tap. */
  let swipeAteClick = false;

  /** What a release in this direction would do, for the drag indicator. */
  function swipeAction(right: boolean): { label: string; positive: boolean } {
    if (!state.revealed) return { label: "Reveal", positive: true };
    const card = state.queue[0];
    if (card && requeuedHashes.has(card.hash)) {
      return right
        ? { label: "Got it", positive: true }
        : { label: "Again", positive: false };
    }
    return right
      ? { label: "Good", positive: true }
      : { label: "Forgot", positive: false };
  }

  function commitSwipe(right: boolean): void {
    // A swipe before the answer is showing means "show me", never a grade —
    // the gesture must not be able to grade a card that was never seen.
    if (!state.revealed) {
      doReveal();
      return;
    }
    const card = state.queue[0];
    if (card && requeuedHashes.has(card.hash)) doRequeue(!right);
    else doGrade(right ? Grade.Good : Grade.Forgot);
  }

  function attachCardGestures(view: DrillUi): void {
    const currentCard = () =>
      view.cardContainer.querySelector(".card") as HTMLElement | null;

    view.cardContainer.addEventListener("click", (e) => {
      if (swipeAteClick || state.revealed) return;
      // Links keep their own behaviour, and the click that ends a text
      // selection is someone reading, not someone asking for the answer.
      if ((e.target as HTMLElement).closest?.("a")) return;
      if (document.getSelection()?.isCollapsed === false) return;
      doReveal();
    });

    view.cardContainer.addEventListener("pointerdown", (e) => {
      // Mouse drags are text selection, and desktop has the keyboard.
      if (e.pointerType === "mouse" || state.queue.length === 0) return;
      drag = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        dx: 0,
        claimed: false,
        armed: false,
      };
    });

    view.cardContainer.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;

      if (!drag.claimed) {
        // Vertical wins ties, so scrolling a long card still works.
        if (Math.abs(dx) < SWIPE_CLAIM_PX || Math.abs(dx) <= Math.abs(dy)) return;
        drag.claimed = true;
        view.cardContainer.setPointerCapture?.(e.pointerId);
      }

      e.preventDefault();
      drag.dx = dx;

      const progress = Math.min(1, Math.abs(dx) / SWIPE_COMMIT_PX);
      if (progress === 1 && !drag.armed) {
        drag.armed = true;
        haptic(8);
      } else if (progress < 1) {
        drag.armed = false;
      }

      const node = currentCard();
      if (node) {
        // A little tilt reads as "picking the card up". Clamped, because a
        // long drag on a wide card otherwise turns into a cartwheel.
        const tilt = Math.max(-3, Math.min(3, dx * 0.02));
        node.style.transition = "none";
        node.style.transform = `translateX(${dx}px) rotate(${tilt}deg)`;
      }

      const action = swipeAction(dx > 0);
      view.swipeHint.textContent = action.label;
      view.swipeHint.classList.toggle("swipe-hint-positive", action.positive);
      view.swipeHint.style.opacity = String(progress);
      view.swipeHint.hidden = false;
    });

    const endDrag = (e: PointerEvent, commit: boolean) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { dx, claimed } = drag;
      drag = null;

      const node = currentCard();
      if (node) {
        node.style.transition = "transform 0.2s ease";
        node.style.transform = "";
      }
      view.swipeHint.hidden = true;
      view.swipeHint.style.opacity = "0";

      if (!claimed) return;
      // The synthetic click that follows a drag belongs to the gesture.
      swipeAteClick = true;
      setTimeout(() => {
        swipeAteClick = false;
      }, 0);

      if (commit && Math.abs(dx) >= SWIPE_COMMIT_PX) commitSwipe(dx > 0);
    };

    view.cardContainer.addEventListener("pointerup", (e) => endDrag(e, true));
    view.cardContainer.addEventListener("pointercancel", (e) =>
      endDrag(e, false)
    );
  }

  /**
   * Built cards are kept only while they might be needed again: the one on
   * screen, the one being prepared behind it, and whatever an undo would bring
   * back. Typeset DOM is not cheap, and a long session would otherwise hold
   * onto every card it had shown.
   */
  const nodeCache = new Map<string, HTMLElement>();

  function cardNode(card: Card): HTMLElement {
    let node = nodeCache.get(card.hash);
    if (!node) {
      node = document.createElement("div");
      node.className = "card";
      node.innerHTML = `
        <div class="card-header">
          <h1>${card.deckName}</h1>
        </div>
        <div class="card-content">${renderCardBody(card)}</div>
      `;
      postRender(node.querySelector(".card-content") as HTMLElement);
      nodeCache.set(card.hash, node);
    }
    return node;
  }

  function pruneNodeCache(): void {
    const keep = new Set<string>();
    for (const card of state.queue.slice(0, 2)) keep.add(card.hash);
    const lastUndo = undoStack[undoStack.length - 1];
    if (lastUndo) keep.add(lastUndo.cardHash);
    for (const hash of nodeCache.keys()) {
      if (!keep.has(hash)) nodeCache.delete(hash);
    }
  }

  const whenIdle: (fn: () => void) => void =
    typeof (window as any).requestIdleCallback === "function"
      ? (fn) => (window as any).requestIdleCallback(fn, { timeout: 500 })
      : (fn) => setTimeout(fn, 0);

  /** Typeset the next card during the seconds the user spends on this one. */
  function prerenderNext(): void {
    const next = state.queue[1];
    if (!next || nodeCache.has(next.hash)) return;
    whenIdle(() => {
      // The queue may have moved on while this was waiting for idle time.
      if (state.queue[1]?.hash === next.hash) cardNode(next);
    });
  }

  /** Unfuzzed interval each grade would produce, shown on the grade buttons. */
  function updatePreviews(card: Card, into: HTMLElement[]): void {
    const perf = state.cache.get(card.hash)!;
    const now = new Date().toISOString();
    const grades = [Grade.Forgot, Grade.Hard, Grade.Good, Grade.Easy] as const;
    grades.forEach((grade, i) => {
      const preview = updatePerformance(perf, grade, now, false);
      into[i].textContent = formatInterval(preview.intervalDays);
    });
  }

  /**
   * The end-of-session summary. Reviews are read back from the store rather
   * than taken from memory so a session picked up across two sittings reports
   * all of itself, not just the part that happened since the app reopened.
   */
  async function showFinished(): Promise<void> {
    ui = null;
    let reviews = state.reviews;
    if (!options.dryRun) {
      // Grades are written behind a queue, and the last one is still in flight
      // when the queue empties. Reading before it lands undercounts the
      // session, usually by exactly the card that just finished it.
      await writeChain;
      reviews = await getReviewsSince(startedAt);
    }
    // An undo during that wait puts a card back; it is no longer the end.
    if (state.queue.length > 0) {
      paint();
      return;
    }
    renderFinished(container, reviews, doEnd);
  }

  function paint() {
    if (state.queue.length === 0) {
      void showFinished();
      return;
    }

    const view = ui ?? (ui = mountShell());
    const card = state.queue[0];
    const isRequeue = requeuedHashes.has(card.hash);

    view.progressFill.style.width = `${(completedHashes.size / state.totalCards) * 100}%`;

    const node = cardNode(card);
    const mountedCard = view.cardContainer.querySelector(".card");
    if (mountedCard !== node) {
      mountedCard?.remove();
      // Before the hint, so a drag indicator paints over the card. A cached
      // node may still carry the transform from the swipe that retired it.
      node.style.transform = "";
      node.style.transition = "";
      view.cardContainer.insertBefore(node, view.swipeHint);
    }
    (node.querySelector(".card-content") as HTMLElement).classList.toggle(
      "revealed",
      state.revealed
    );
    view.cardContainer.classList.toggle("revealable", !state.revealed);

    view.controls.classList.toggle("requeue-controls", isRequeue);
    view.undoBtn.disabled = undoStack.length === 0;
    view.revealBtn.hidden = state.revealed;
    view.grades.hidden = !state.revealed || isRequeue;
    view.requeueGrades.hidden = !state.revealed || !isRequeue;

    // Cheap arithmetic, so computed up front rather than at reveal — by the
    // time the grades appear there is nothing left to do.
    if (!isRequeue) updatePreviews(card, view.previews);

    prerenderNext();
    pruneNodeCache();
  }

  function doReveal() {
    if (state.revealed || state.queue.length === 0) return;
    state.revealed = true;
    paint();
  }

  const useFuzz = getIntervalFuzz();
  const useHaptic = getHapticFeedback();

  function haptic(ms: number = 10) {
    if (useHaptic && navigator.vibrate) navigator.vibrate(ms);
  }

  function doGrade(grade: Grade) {
    if (!state.revealed) return;
    haptic();

    const reviewedAt = new Date().toISOString();
    const card = state.queue.shift()!;
    const perf = state.cache.get(card.hash)!;
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

    state.cache.set(card.hash, newPerf);

    // Record new card introduction only when actually graded
    if (newCardHashes.has(card.hash) && !gradedNewCards.has(card.hash)) {
      gradedNewCards.add(card.hash);
      recordIntroduced(todayStr(), 1);
    }

    // Re-add to back if Forgot or Hard (for reinforcement, no further FSRS)
    if (grade === Grade.Forgot || grade === Grade.Hard) {
      requeuedHashes.add(card.hash);
      state.queue.push(card);
    } else {
      completedHashes.add(card.hash);
    }

    state.reviews.push(review);

    const undoEntry: UndoEntry = {
      type: "grade",
      cardHash: card.hash,
      grade,
      prevPerf: perf,
      reviewKey: null,
    };
    undoStack.push(undoEntry);

    if (!options.dryRun) {
      const session = snapshot();
      enqueueWrite(async () => {
        undoEntry.reviewKey = await persistReview(
          card.hash,
          newPerf,
          review,
          session
        );
      });
    }

    state.revealed = false;
    paint();
  }

  function doRequeue(again: boolean) {
    if (!state.revealed) return;
    haptic();

    const card = state.queue.shift()!;
    undoStack.push({ type: "requeue", cardHash: card.hash, again });

    if (again) {
      state.queue.push(card);
    } else {
      requeuedHashes.delete(card.hash);
      completedHashes.add(card.hash);
    }

    if (!options.dryRun) {
      const session = snapshot();
      enqueueWrite(() => saveSession(session));
    }

    state.revealed = false;
    paint();
  }

  async function doUndo() {
    if (undoStack.length === 0) return;

    const entry = undoStack.pop()!;
    const card = dueCards.find((c) => c.hash === entry.cardHash);
    if (!card) return;

    if (entry.type === "requeue") {
      if (entry.again) {
        // "Again" pushed card to back — remove it
        const idx = state.queue.findLastIndex((c) => c.hash === card.hash);
        if (idx >= 0) state.queue.splice(idx, 1);
      } else {
        // "Got it" removed card from queue — restore re-queue state
        requeuedHashes.add(card.hash);
        completedHashes.delete(card.hash);
      }
      state.queue.unshift(card);

      if (!options.dryRun) {
        const session = snapshot();
        enqueueWrite(() => saveSession(session));
      }
    } else {
      // Undo a real FSRS grade
      state.reviews.pop();

      if (entry.grade === Grade.Forgot || entry.grade === Grade.Hard) {
        const idx = state.queue.findLastIndex((c) => c.hash === card.hash);
        if (idx >= 0) state.queue.splice(idx, 1);
        requeuedHashes.delete(card.hash);
      } else {
        completedHashes.delete(card.hash);
      }

      // Reverse new card budget if this was a new card's first grade
      if (gradedNewCards.has(card.hash)) {
        const stillGraded = state.reviews.some((r) => r.cardHash === card.hash);
        if (!stillGraded) {
          gradedNewCards.delete(card.hash);
          recordIntroduced(todayStr(), -1);
        }
      }

      state.queue.unshift(card);

      // Reverse the persisted write. The queue is serialized, so the grade's
      // write has landed and its key is populated by the time this runs.
      if (!options.dryRun) {
        const session = snapshot();
        await enqueueWrite(() =>
          revertReview(
            entry.cardHash,
            entry.prevPerf,
            entry.reviewKey,
            session
          )
        );
      }
      state.cache.set(card.hash, entry.prevPerf);
    }

    state.revealed = false;
    paint();
  }

  async function doEnd() {
    if (!options.dryRun) {
      enqueueWrite(() => clearSession());
      await writeChain;

      // Every grade is already durable locally, so pushing them to GitHub is
      // not something to hold the user behind on the way out of a drill. It
      // runs behind the deck list, which reports its progress and failures.
      const config = getConfig();
      if (config && navigator.onLine) syncStateOnly(config);
    }

    onEnd();
  }

  // Keyboard shortcuts
  const keyboardAC = new AbortController();

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const currentCard = state.queue[0];
    const isRequeue = currentCard && requeuedHashes.has(currentCard.hash);
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      doReveal(); // Reveal, and only ever reveal
    } else if (state.revealed && isRequeue && (e.key === "Enter" || e.key === "2")) {
      doRequeue(false); // Enter or 2 = Got it
    } else if (state.revealed && isRequeue && e.key === "1") {
      doRequeue(true); // 1 = Again
    } else if (state.revealed && !isRequeue && e.key >= "1" && e.key <= "4") {
      doGrade(parseInt(e.key) as Grade);
    } else if (e.key === "u" || e.key === "U") {
      doUndo();
    }
  }, { signal: keyboardAC.signal });

  const origOnEnd = onEnd;
  onEnd = () => {
    keyboardAC.abort();
    origOnEnd();
  };

  paint();
}

function renderFinished(
  container: HTMLElement,
  reviews: Review[],
  onDone: () => void
): void {
  const gradeCount = { forgot: 0, hard: 0, good: 0, easy: 0 };
  for (const r of reviews) {
    switch (r.grade) {
      case Grade.Forgot:
        gradeCount.forgot++;
        break;
      case Grade.Hard:
        gradeCount.hard++;
        break;
      case Grade.Good:
        gradeCount.good++;
        break;
      case Grade.Easy:
        gradeCount.easy++;
        break;
    }
  }

  container.innerHTML = `
    <div class="finished">
      <h1>Session Complete</h1>
      <div class="summary">Reviewed ${reviews.length} card${reviews.length === 1 ? "" : "s"}</div>
      <h2>Stats</h2>
      <div class="stats">
        <table>
          <tr><td class="key">Forgot</td><td class="val">${gradeCount.forgot}</td></tr>
          <tr><td class="key">Hard</td><td class="val">${gradeCount.hard}</td></tr>
          <tr><td class="key">Good</td><td class="val">${gradeCount.good}</td></tr>
          <tr><td class="key">Easy</td><td class="val">${gradeCount.easy}</td></tr>
        </table>
      </div>
      <div class="shutdown-container">
        <button id="done-btn" class="btn btn-primary shutdown-button">Done</button>
      </div>
    </div>
  `;

  container.querySelector("#done-btn")!.addEventListener("click", onDone);
}
