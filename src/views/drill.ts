import { Card, Grade, Performance, Review } from "../types";
import { updatePerformance, todayStr, formatInterval } from "../fsrs";
import { getPerformance, getAllPerformances, saveSessionResults } from "../db";
import { renderFront, renderBack, postRender } from "../render";
import { getConfig, getIntervalFuzz, getHapticFeedback } from "../github";
import { recordIntroduced } from "../new-card-budget";
import { fullSync } from "../sync";

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
};

export async function renderDrill(
  container: HTMLElement,
  dueCards: Card[],
  onEnd: () => void,
  options: DrillOptions = {}
): Promise<void> {
  // Shuffle
  const queue = [...dueCards];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  // Bury cloze siblings: keep only first card per family hash
  const seenFamilies = new Set<string>();
  const filtered: Card[] = [];
  for (const card of queue) {
    if (card.familyHash) {
      if (seenFamilies.has(card.familyHash)) continue;
      seenFamilies.add(card.familyHash);
    }
    filtered.push(card);
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
  const gradedNewCards = new Set<string>();

  type UndoEntry =
    | { type: "grade"; cardHash: string; grade: Grade }
    | { type: "requeue"; cardHash: string; again: boolean };

  const requeuedHashes = new Set<string>();
  const completedHashes = new Set<string>();
  const undoStack: UndoEntry[] = [];

  const state: SessionState = {
    queue: filtered,
    reviews: [],
    cache,
    revealed: false,
    totalCards: filtered.length,
  };

  function render() {
    if (state.queue.length === 0) {
      renderFinished(container, state, onEnd, options);
      return;
    }

    const card = state.queue[0];
    const isRequeue = requeuedHashes.has(card.hash);
    const progress = (completedHashes.size / state.totalCards) * 100;

    // Compute interval previews for each grade (unfuzzed) — only for normal reviews
    const previews = state.revealed && !isRequeue
      ? ([Grade.Forgot, Grade.Hard, Grade.Good, Grade.Easy] as const).map((g) => {
          const perf = state.cache.get(card.hash)!;
          const preview = updatePerformance(perf, g, new Date().toISOString(), false);
          return formatInterval(preview.intervalDays);
        })
      : [];

    container.innerHTML = `
      <div class="root">
        <div class="header">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress}%"></div>
          </div>
        </div>
        <div class="card-container">
          <div class="card">
            <div class="card-header">
              <h1>${card.deckName}</h1>
            </div>
            <div class="card-content">
              ${
                card.content.type === "basic"
                  ? `
                <div class="question">${renderFront(card)}</div>
                <div class="answer" style="${state.revealed ? "" : "visibility: hidden"}">${renderBack(card)}</div>
              `
                  : `
                <div class="prompt">${state.revealed ? renderBack(card) : renderFront(card)}</div>
              `
              }
            </div>
          </div>
        </div>
        <div class="controls${isRequeue ? " requeue-controls" : ""}">
          <div class="control-row">
            <button id="undo-btn" class="btn" ${undoStack.length === 0 ? "disabled" : ""}>Undo</button>
            ${
              !state.revealed
                ? `<button id="reveal-btn" class="btn">Reveal</button>`
                : isRequeue
                ? `
              <div class="grades requeue-grades">
                <button class="btn requeue-btn" data-action="again">Again</button>
                <button class="btn requeue-btn" data-action="done">Got it</button>
              </div>
            `
                : `
              <div class="grades">
                <button class="btn grade-btn" data-grade="1">Forgot<span class="interval-preview">${previews[0]}</span></button>
                <button class="btn grade-btn" data-grade="2">Hard<span class="interval-preview">${previews[1]}</span></button>
                <button class="btn grade-btn" data-grade="3">Good<span class="interval-preview">${previews[2]}</span></button>
                <button class="btn grade-btn" data-grade="4">Easy<span class="interval-preview">${previews[3]}</span></button>
              </div>
            `
            }
            <button id="end-btn" class="btn">End</button>
          </div>
        </div>
      </div>
    `;

    // Post-render for KaTeX and highlight.js
    const cardContent = container.querySelector(".card-content");
    if (cardContent) postRender(cardContent as HTMLElement);

    // Event handlers
    container
      .querySelector("#reveal-btn")
      ?.addEventListener("click", () => doReveal());

    container.querySelectorAll(".grade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const grade = parseInt(
          (btn as HTMLElement).dataset.grade!
        ) as Grade;
        doGrade(grade);
      });
    });

    container.querySelectorAll(".requeue-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = (btn as HTMLElement).dataset.action!;
        doRequeue(action === "again");
      });
    });

    container
      .querySelector("#undo-btn")
      ?.addEventListener("click", () => doUndo());

    container
      .querySelector("#end-btn")
      ?.addEventListener("click", () => doEnd());
  }

  function doReveal() {
    if (!state.revealed) {
      state.revealed = true;
      render();
    }
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
    undoStack.push({ type: "grade", cardHash: card.hash, grade });
    state.revealed = false;

    if (state.queue.length === 0) {
      doEnd();
    } else {
      render();
    }
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

    state.revealed = false;

    if (state.queue.length === 0) {
      doEnd();
    } else {
      render();
    }
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

      // Restore cache from IndexedDB
      const origPerf = await getPerformance(card.hash);
      state.cache.set(card.hash, origPerf);
    }

    state.revealed = false;
    render();
  }

  async function doEnd() {
    if (!options.dryRun) {
      await saveSessionResults(state.cache, state.reviews);

      const config = getConfig();
      if (config && navigator.onLine) {
        try {
          await fullSync(config);
        } catch (e) {
          console.warn("Sync after session failed:", e);
        }
      }
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
      if (!state.revealed) doReveal();
      else if (isRequeue) doRequeue(true); // Space = Again
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

  render();
}

function renderFinished(
  container: HTMLElement,
  state: SessionState,
  onEnd: () => void,
  options: DrillOptions = {}
): void {
  const gradeCount = { forgot: 0, hard: 0, good: 0, easy: 0 };
  for (const r of state.reviews) {
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
      <div class="summary">Reviewed ${state.reviews.length} cards</div>
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
        <button id="done-btn" class="btn btn-danger shutdown-button">Done</button>
      </div>
    </div>
  `;

  container.querySelector("#done-btn")!.addEventListener("click", async () => {
    if (!options.dryRun) {
      await saveSessionResults(state.cache, state.reviews);
      const config = getConfig();
      if (config && navigator.onLine) {
        try {
          await fullSync(config);
        } catch (e) {
          console.warn("Sync failed:", e);
        }
      }
    }
    onEnd();
  });
}
