import { Card, Grade, Review } from "../../types";
import { cardSourceUrl, getConfig } from "../../github";
import { renderCardBody, postRender } from "../../render";
import { attachCardGestures } from "./gestures";
import { Session } from "./session";

/**
 * The drill's DOM. The chrome is built once and then mutated: revealing is a
 * class toggle, advancing swaps a prepared node into place, and the next card
 * is typeset while the current one is on screen — so no interaction re-parses
 * markdown or re-runs KaTeX and highlight.js over content that has not changed.
 */

type Chrome = {
  progressFill: HTMLElement;
  editLink: HTMLAnchorElement;
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

export type DrillView = {
  paint(): void;
};

export type ViewOptions = {
  /** Demo cards have no repo behind them, so they get no edit link. */
  sourceLinks?: boolean;
};

export function createView(
  container: HTMLElement,
  session: Session,
  onFinish: () => void,
  options: ViewOptions = {}
): DrillView {
  const repo = options.sourceLinks === false ? null : getConfig();
  let chrome: Chrome | null = null;
  let summaryShown = false;
  let buildingSummary = false;

  function mountChrome(): Chrome {
    const root = document.createElement("div");
    root.className = "root";
    root.innerHTML = `
      <div class="header">
        <div class="header-row">
          <div class="progress-bar">
            <div class="progress-fill"></div>
          </div>
          <a class="edit-link" id="edit-link" target="_blank" rel="noopener" hidden>Edit</a>
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

    const mounted: Chrome = {
      progressFill: pick(".progress-fill"),
      editLink: pick<HTMLAnchorElement>("#edit-link"),
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
    mounted.revealBtn.addEventListener("click", () => session.reveal());
    mounted.undoBtn.addEventListener("click", () => void session.undo());
    pick("#end-btn").addEventListener("click", onFinish);

    mounted.grades.querySelectorAll(".grade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        session.grade(parseInt((btn as HTMLElement).dataset.grade!) as Grade);
      });
    });

    mounted.requeueGrades.querySelectorAll(".requeue-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        session.requeue((btn as HTMLElement).dataset.action === "again");
      });
    });

    attachCardGestures(mounted.cardContainer, mounted.swipeHint, session);
    return mounted;
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
    const keep = new Set(
      [session.current?.hash, session.next?.hash, session.undoTarget].filter(
        (hash): hash is string => hash !== undefined && hash !== null
      )
    );
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
    const next = session.next;
    if (!next || nodeCache.has(next.hash)) return;
    whenIdle(() => {
      // The queue may have moved on while this was waiting for idle time.
      if (session.next?.hash === next.hash) cardNode(next);
    });
  }

  async function showSummary(): Promise<void> {
    // `summary()` waits on the last write, so guard against a second change
    // arriving mid-await and rendering the screen twice.
    if (summaryShown || buildingSummary) return;
    buildingSummary = true;
    chrome = null;
    let reviews: Review[];
    try {
      reviews = await session.summary();
    } finally {
      buildingSummary = false;
    }
    // An undo during that wait puts a card back; it is no longer the end.
    if (!session.finished) {
      paint();
      return;
    }
    summaryShown = true;
    renderSummary(container, reviews, onFinish);
  }

  function paint(): void {
    if (session.finished) {
      void showSummary();
      return;
    }
    summaryShown = false;

    const view = chrome ?? (chrome = mountChrome());
    const card = session.current!;
    const requeued = session.requeued;

    view.progressFill.style.width = `${session.progress * 100}%`;
    view.writeError.hidden = !session.writeFailed;

    // Points at the card on screen, so it follows the drill rather than being
    // set once and quietly going stale.
    view.editLink.hidden = repo === null;
    if (repo) view.editLink.href = cardSourceUrl(repo, card);

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
      session.revealed
    );
    view.cardContainer.classList.toggle("revealable", !session.revealed);

    view.controls.classList.toggle("requeue-controls", requeued);
    view.undoBtn.disabled = !session.canUndo;
    view.revealBtn.hidden = session.revealed;
    view.grades.hidden = !session.revealed || requeued;
    view.requeueGrades.hidden = !session.revealed || !requeued;

    // Cheap arithmetic, so computed up front rather than at reveal — by the
    // time the grades appear there is nothing left to do.
    if (!requeued) {
      const previews = session.previews();
      view.previews.forEach((el, i) => {
        el.textContent = previews[i] ?? "";
      });
    }

    prerenderNext();
    pruneNodeCache();
  }

  return { paint };
}

function renderSummary(
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
