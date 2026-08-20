import { html, render, TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { Card, Grade, Review } from "../../types";
import { renderCardBody } from "../../render";
import { typeset } from "../../typeset";
import { attachCardGestures } from "./gestures";
import { Session } from "./session";

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
  /** Opens the editor on the card in front of you. Absent in demo mode, which
   *  has no repo behind it and so nothing to edit. */
  onEdit?: () => void;
};

export function createView(
  container: HTMLElement,
  session: Session,
  onFinish: () => void,
  options: ViewOptions = {}
): DrillView {
  const onEdit = options.onEdit;
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
      render(
        html`<div class="card-header">
            <h1>${card.deckName}</h1>
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

  function drill(node: HTMLElement): TemplateResult {
    const requeued = session.requeued;
    const revealed = session.revealed;
    // Cheap arithmetic, so computed up front rather than at reveal — by the
    // time the grades appear there is nothing left to do.
    const previews = requeued ? [] : session.previews();

    return html`<div class="root">
      <div class="header">
        <div class="header-row">
          <div class="progress-bar">
            <div
              class="progress-fill"
              style="width: ${session.progress * 100}%"
            ></div>
          </div>
          <!-- Was a deep link to GitHub, which meant leaving the drill,
               finding the card in a web editor and finding your way back. The
               same sheet the leech list uses opens over the card instead. -->
          <button
            class="edit-link"
            id="edit-link"
            type="button"
            ?hidden=${onEdit === undefined}
            @click=${() => onEdit?.()}
          >
            Edit
          </button>
        </div>
        <div class="write-error" role="alert" ?hidden=${!session.writeFailed}>
          Couldn't save progress on this device — reviews from this session may
          be lost.
        </div>
      </div>
      <div class="card-container ${revealed ? "" : "revealable"}">
        ${node}
        <div class="swipe-hint" aria-hidden="true" hidden></div>
      </div>
      <div class="controls ${requeued ? "requeue-controls" : ""}">
        <div class="control-row">
          <button
            id="undo-btn"
            class="btn"
            ?disabled=${!session.canUndo}
            @click=${() => void session.undo()}
          >Undo</button>
          <button
            id="reveal-btn"
            class="btn"
            ?hidden=${revealed}
            @click=${() => session.reveal()}
          >Reveal</button>
          <div class="grades" ?hidden=${!revealed || requeued}>
            ${GRADES.map(
              ([grade, label], i) => html`<button
                class="btn grade-btn"
                data-grade=${grade}
                @click=${() => session.grade(grade)}
              >
                ${label}<span class="interval-preview">${previews[i] ?? ""}</span>
              </button>`
            )}
          </div>
          <div
            class="grades requeue-grades"
            ?hidden=${!revealed || !requeued}
          >
            <button
              class="btn requeue-btn"
              data-action="again"
              @click=${() => session.requeue(true)}
            >Again</button>
            <button
              class="btn requeue-btn"
              data-action="done"
              @click=${() => session.requeue(false)}
            >Got it</button>
          </div>
          <button id="end-btn" class="btn" @click=${onFinish}>End</button>
        </div>
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
    <h1>Session Complete</h1>
    <div class="summary">
      ${`Reviewed ${reviews.length} card${reviews.length === 1 ? "" : "s"}`}
    </div>
    <h2>Stats</h2>
    <div class="stats">
      <table>
        ${GRADES.map(
          ([grade, label]) => html`<tr>
            <td class="key">${label}</td>
            <td class="val">${counts.get(grade) ?? 0}</td>
          </tr>`
        )}
      </table>
    </div>
    <div class="shutdown-container">
      <button
        id="done-btn"
        class="btn btn-primary shutdown-button"
        @click=${onDone}
      >
        Done
      </button>
    </div>
  </div>`;
}
