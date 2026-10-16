import { html, nothing, render, TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { Card, Grade, Review } from "../../types";
import { renderCardBody } from "../../render";
import { typeset } from "../../typeset";
import { attachCardGestures } from "./gestures";
import { Session } from "./session";
import { icon } from "../icons";

/**
 * The drill's DOM.
 *
 * The chrome is a template of the session's state, but the *card* is not: it is
 * a built node, kept in a cache, and typeset while the previous card is still
 * on screen — so no interaction re-parses markdown or re-runs KaTeX and
 * highlight.js over content that has not changed. lit-html takes a Node as a
 * value, so the two live together: the chrome repaints freely, and the card is
 * moved rather than rebuilt.
 */

export type DrillView = {
  paint(): void;
};

export type ViewOptions = {
  /** Opens the editor on the card in front of you. Absent in a dry run, which
   *  has no repo behind it and so nothing to edit. */
  onEdit?: () => void;
  /** Whether the card on screen right now can be edited — a drill can span
   *  collections, and a subscription is read here and never written to. */
  canEdit?: () => boolean;
};

export function createView(
  container: HTMLElement,
  session: Session,
  onFinish: () => void,
  options: ViewOptions = {}
): DrillView {
  const onEdit = options.onEdit;
  const canEdit = options.canEdit ?? (() => true);
  let summaryShown = false;
  let buildingSummary = false;
  /** The card node last put on screen, so a returning one can be un-swiped. */
  let mountedNode: HTMLElement | null = null;
  /** The container gestures are bound to, which changes if the DOM is rebuilt. */
  let gesturesOn: HTMLElement | null = null;

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
      // The body is HTML on purpose — `renderCardBody` is markdown that has
      // already been rendered — so it says so. The deck name is not, and used
      // to be interpolated into the same string unescaped.
      // The tools slot is the one part repainted with the chrome: whether the
      // card is new, and whether it can be edited, belong to this moment
      // rather than to the card.
      render(
        html`<div class="card-header">
            <span class="card-deck">${card.deckName}</span>
            <span class="card-tools"></span>
          </div>
          <div class="card-content">${unsafeHTML(renderCardBody(card))}</div>`,
        node
      );
      const built = node;
      // Maths and highlighting change how tall the card is, so whether it has
      // anywhere to scroll is not settled until they have run.
      void typeset(built.querySelector(".card-content") as HTMLElement).then(
        () => {
          if (mountedNode === built) syncScrollLock();
        }
      );
      nodeCache.set(card.hash, node);
    }
    return node;
  }

  /**
   * Tell the container whether the card on screen has anywhere to scroll.
   *
   * This is what decides who arbitrates the gesture. While a card overflows,
   * the browser is given vertical panning and takes precedence over the swipe
   * handler — a gesture it reads as a pan is claimed and cancelled, and there
   * is no getting it back. While a card fits, conceding that buys nothing and
   * costs swipes, so nothing is conceded.
   */
  function syncScrollLock(): void {
    const container = mountedNode?.closest(".card-container");
    const content = mountedNode?.querySelector(".card-content");
    if (!container || !content) return;
    container.classList.toggle(
      "card-fits",
      content.scrollHeight <= content.clientHeight
    );
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

  /** Deck-side extras, drawn into the card itself so they move with a swipe. */
  function tools(): TemplateResult {
    return html`${session.currentIsNew
        ? html`<span class="pill pill-tint">New</span>`
        : nothing}
      <button
        class="icon-btn card-edit"
        id="edit-link"
        type="button"
        aria-label="Edit card"
        title="Edit card"
        ?hidden=${onEdit === undefined || !canEdit()}
        @click=${(e: Event) => {
          // The card is also the reveal target; editing it is not a tap on it.
          e.stopPropagation();
          onEdit?.();
        }}
      >
        ${icon("edit", 17)}<span class="icon-btn-label">Edit</span><kbd>E</kbd>
      </button>`;
  }

  function drill(node: HTMLElement): TemplateResult {
    const revealed = session.revealed;
    // Cheap arithmetic, so computed up front rather than at reveal — by the
    // time the grades appear there is nothing left to do.
    const previews = session.previews();

    return html`<div class="root drill">
      <header class="drill-bar header">
        <button
          id="end-btn"
          class="icon-btn"
          type="button"
          aria-label="End session"
          title="End session"
          @click=${onFinish}
        >
          ${icon("x")}<span class="icon-btn-label">End</span>
        </button>
        <div class="progress">
          <div class="progress-bar">
            <div
              class="progress-fill"
              style="width: ${session.progress * 100}%"
            ></div>
          </div>
          <span class="progress-count">${`${session.done} / ${session.total}`}</span>
        </div>
        <button
          id="undo-btn"
          class="icon-btn"
          type="button"
          aria-label="Undo last grade"
          title="Undo last grade"
          ?disabled=${!session.canUndo}
          @click=${() => void session.undo()}
        >
          ${icon("undo", 21)}<span class="icon-btn-label">Undo</span><kbd>U</kbd>
        </button>
      </header>
      <div
        class="notice notice-error write-error"
        role="alert"
        ?hidden=${!session.writeFailed}
      >
        <span>Couldn't save progress on this device — reviews from this session
        may be lost.</span>
      </div>
      <div class="card-container ${revealed ? "" : "revealable"}">
        ${node}
        <div
          class="swipe-hint"
          aria-hidden="true"
          hidden
          data-forgot=${previews[0] ?? ""}
          data-good=${previews[2] ?? ""}
        ></div>
      </div>
      <div class="controls">
        <button
          id="reveal-btn"
          class="btn btn-primary btn-lg reveal-btn"
          type="button"
          ?hidden=${revealed}
          @click=${() => session.reveal()}
        >Show answer<kbd>Space</kbd></button>
        <div class="grades" ?hidden=${!revealed}>
          ${GRADES.map(
            ([grade, label], i) => html`<button
              class="grade-btn"
              type="button"
              data-grade=${grade}
              @click=${() => session.grade(grade)}
            >
              <kbd>${grade === Grade.Good ? "3 / Space" : grade}</kbd>
              <span class="grade-text">
                <span class="grade-label">${label}</span>
                <span class="interval-preview">${previews[i] ?? ""}</span>
              </span>
            </button>`
          )}
        </div>
        <p class="controls-hint" aria-hidden="true">
          <span class="hint-idle"
            >${revealed ? "tap the card for Good, or swipe" : "or tap the card"}</span
          ><span class="hint-reveal">Release to show the answer</span
          ><span class="hint-good">Release to grade Good</span
          ><span class="hint-forgot">Release to grade Forgot</span>
        </p>
      </div>
    </div>`;
  }

  /**
   * Gestures bind to the container rather than to the card, so they survive a
   * card being swapped — but not the whole view being rebuilt, which is what
   * returning from the summary screen after an undo does.
   */
  function attachGestures(): void {
    const cardContainer = container.querySelector(
      ".card-container"
    ) as HTMLElement | null;
    const hint = container.querySelector(".swipe-hint") as HTMLElement | null;
    if (!cardContainer || !hint || gesturesOn === cardContainer) return;
    attachCardGestures(cardContainer, hint, session);
    gesturesOn = cardContainer;
  }

  async function showSummary(): Promise<void> {
    // `summary()` waits on the last write, so guard against a second change
    // arriving mid-await and rendering the screen twice.
    if (summaryShown || buildingSummary) return;
    buildingSummary = true;
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
    mountedNode = null;
    gesturesOn = null;
    render(summary(reviews, onFinish), container);
  }

  function paint(): void {
    if (session.finished) {
      void showSummary();
      return;
    }
    summaryShown = false;

    const card = session.current!;
    const node = cardNode(card);
    if (node !== mountedNode) {
      // A cached node may still carry the transform from the swipe that
      // retired it.
      node.style.transform = "";
      node.style.transition = "";
      mountedNode = node;
    }
    (node.querySelector(".card-content") as HTMLElement).classList.toggle(
      "revealed",
      session.revealed
    );

    render(drill(node), container);
    render(tools(), node.querySelector(".card-tools") as HTMLElement);
    attachGestures();
    syncScrollLock();
    prerenderNext();
    pruneNodeCache();
  }

  return { paint };
}

const GRADES: [Grade, string][] = [
  [Grade.Forgot, "Forgot"],
  [Grade.Hard, "Hard"],
  [Grade.Good, "Good"],
  [Grade.Easy, "Easy"],
];

function summary(reviews: Review[], onDone: () => void): TemplateResult {
  const counts = new Map<Grade, number>();
  for (const r of reviews) counts.set(r.grade, (counts.get(r.grade) ?? 0) + 1);

  return html`<div class="finished">
    <div class="finished-body">
      <span class="done-badge">${icon("check", 24)}</span>
      <h1>Session complete</h1>
      <p class="summary">
        ${`Reviewed ${reviews.length} card${reviews.length === 1 ? "" : "s"}`}
      </p>
      <div class="list stats">
        ${GRADES.map(
          ([grade, label]) => html`<div class="row">
            <span class="grade-dot grade-${label.toLowerCase()}"></span>
            <span class="row-text key">${label}</span>
            <span class="val">${counts.get(grade) ?? 0}</span>
          </div>`
        )}
      </div>
      <button
        id="done-btn"
        class="btn btn-primary btn-lg btn-block shutdown-button"
        @click=${onDone}
      >
        Done
      </button>
    </div>
  </div>`;
}
