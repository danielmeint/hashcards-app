import { Card, Grade, Performance, Review } from "../types";
import { updatePerformance, todayStr } from "../fsrs";
import { getPerformance, saveSessionResults } from "../db";
import { renderFront, renderBack, postRender } from "../render";
import { getConfig, getIntervalFuzz, getHapticFeedback, recordNewCardsIntroduced } from "../github";
import { fullSync } from "../sync";

type SessionState = {
  queue: Card[];
  reviews: Review[];
  cache: Map<string, Performance>;
  revealed: boolean;
  totalCards: number;
};

export async function renderDrill(
  container: HTMLElement,
  dueCards: Card[],
  onEnd: () => void
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

  // Populate cache from IndexedDB
  const cache = new Map<string, Performance>();
  for (const card of filtered) {
    if (!cache.has(card.hash)) {
      cache.set(card.hash, await getPerformance(card.hash));
    }
  }

  // Track which cards are new (never reviewed before)
  const newCardHashes = new Set<string>();
  for (const [hash, perf] of cache) {
    if (perf.type === "new") newCardHashes.add(hash);
  }
  const gradedNewCards = new Set<string>();

  const state: SessionState = {
    queue: filtered,
    reviews: [],
    cache,
    revealed: false,
    totalCards: filtered.length,
  };

  function render() {
    if (state.queue.length === 0) {
      renderFinished(container, state, onEnd);
      return;
    }

    const card = state.queue[0];
    const done = state.totalCards - state.queue.length;
    const progress = (done / state.totalCards) * 100;

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
        <div class="controls">
          <div class="control-row">
            <button id="undo-btn" ${state.reviews.length === 0 ? "disabled" : ""}>Undo</button>
            ${
              !state.revealed
                ? `<button id="reveal-btn">Reveal</button>`
                : `
              <div class="grades">
                <button class="grade-btn" data-grade="1">Forgot</button>
                <button class="grade-btn" data-grade="2">Hard</button>
                <button class="grade-btn" data-grade="3">Good</button>
                <button class="grade-btn" data-grade="4">Easy</button>
              </div>
            `
            }
            <button id="end-btn">End</button>
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
      recordNewCardsIntroduced(todayStr(), 1);
    }

    // Re-add to back if Forgot or Hard
    if (grade === Grade.Forgot || grade === Grade.Hard) {
      state.queue.push(card);
    }

    state.reviews.push(review);
    state.revealed = false;

    if (state.queue.length === 0) {
      doEnd();
    } else {
      render();
    }
  }

  async function doUndo() {
    if (state.reviews.length === 0) return;

    const lastReview = state.reviews.pop()!;
    const card = dueCards.find((c) => c.hash === lastReview.cardHash);
    if (!card) return;

    // If the card was re-added (Forgot/Hard), remove it from the back
    if (
      lastReview.grade === Grade.Forgot ||
      lastReview.grade === Grade.Hard
    ) {
      const idx = state.queue.findLastIndex(
        (c) => c.hash === lastReview.cardHash
      );
      if (idx >= 0) state.queue.splice(idx, 1);
    }

    // Reverse new card budget if this was a new card's first grade
    if (gradedNewCards.has(card.hash)) {
      // Only reverse if no earlier review of this card remains in the session
      const stillGraded = state.reviews.some((r) => r.cardHash === card.hash);
      if (!stillGraded) {
        gradedNewCards.delete(card.hash);
        recordNewCardsIntroduced(todayStr(), -1);
      }
    }

    // Put card back at front
    state.queue.unshift(card);

    // Restore cache from IndexedDB
    const origPerf = await getPerformance(card.hash);
    state.cache.set(card.hash, origPerf);

    state.revealed = false;
    render();
  }

  async function doEnd() {
    await saveSessionResults(state.cache, state.reviews);

    // Try to sync
    const config = getConfig();
    if (config && navigator.onLine) {
      try {
        await fullSync(config);
      } catch (e) {
        console.warn("Sync after session failed:", e);
      }
    }

    onEnd();
  }

  // Keyboard shortcuts
  function handleKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!state.revealed) doReveal();
    } else if (state.revealed && e.key >= "1" && e.key <= "4") {
      doGrade(parseInt(e.key) as Grade);
    } else if (e.key === "u" || e.key === "U") {
      doUndo();
    }
  }

  document.addEventListener("keydown", handleKey);

  // Store cleanup function
  const origOnEnd = onEnd;
  onEnd = () => {
    document.removeEventListener("keydown", handleKey);
    origOnEnd();
  };

  render();
}

function renderFinished(
  container: HTMLElement,
  state: SessionState,
  onEnd: () => void
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
        <button id="done-btn" class="shutdown-button">Done</button>
      </div>
    </div>
  `;

  container.querySelector("#done-btn")!.addEventListener("click", async () => {
    await saveSessionResults(state.cache, state.reviews);
    const config = getConfig();
    if (config && navigator.onLine) {
      try {
        await fullSync(config);
      } catch (e) {
        console.warn("Sync failed:", e);
      }
    }
    onEnd();
  });
}
