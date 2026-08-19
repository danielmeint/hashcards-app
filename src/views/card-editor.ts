import { html, nothing, render } from "lit-html";
import { Card } from "../types";
import { ConflictError, GitHubConfig, cardSourceUrl } from "../github";
import {
  CardSource,
  EditResult,
  commitCardEdit,
  readCardSource,
} from "../card-edit";
import { getAllPerformances } from "../db";
import { syncStateOnly } from "../sync";

/**
 * Rewrite a card without leaving the app.
 *
 * The point of the sheet over the deep link it replaces: it shows the card's
 * own lines rather than the whole file, it is one tap from the list that told
 * you the card was bad, and it can offer to keep the card's scheduling — which
 * nothing outside the app is in a position to do, since the hash changes with
 * the text.
 *
 * Resolves with what the edit produced, or `null` if nothing was committed.
 */

/**
 * What the sheet is doing, which is the only thing the template reads.
 *
 * Written as a state and a template of it rather than as a built DOM and a set
 * of functions that reach back into it. The previous version had six of those
 * — `refreshSave` alone set a label, two classes, a disabled flag and the
 * visibility of a checkbox — and every one of them had to be remembered at
 * every transition. Here a transition assigns to `phase` and paints.
 */
type Phase =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "editing";
      source: CardSource;
      /** What is in the box, which is not what was fetched once typing starts. */
      text: string;
      /** Reviews this card has, or `null` if it has no history to keep. */
      reviews: number | null;
      keep: boolean;
      saving: boolean;
      error: string | null;
    };

export function openCardEditor(
  card: Card,
  config: GitHubConfig
): Promise<EditResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    let phase: Phase = { kind: "loading" };

    const editing = () => (phase.kind === "editing" ? phase : null);
    const dirty = () => {
      const state = editing();
      return state !== null && state.text !== state.source.text;
    };
    const removing = () => editing()?.text.trim() === "";
    const saving = () => editing()?.saving === true;

    function paint(): void {
      render(view(), host);
    }

    function finish(result: EditResult | null): void {
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (saving()) return;
      // Escape gives up the sheet, but not typing that is not saved anywhere
      // else — Cancel is one tap away and says what it does.
      if (e.key === "Escape" && !dirty()) {
        e.preventDefault();
        finish(null);
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty()) {
        e.preventDefault();
        void commit();
      }
    }

    async function commit(): Promise<void> {
      const state = editing();
      if (!state || state.saving) return;
      phase = { ...state, saving: true, error: null };
      paint();
      try {
        const result = await commitCardEdit(
          config,
          card,
          state.source,
          state.text,
          { keepScheduling: state.keep }
        );
        // Scheduling that moved to a new hash only exists on this device until
        // it is pushed. Not waited on: the deck list reports sync, and this
        // sheet is finished either way.
        void syncStateOnly(config);
        finish(result);
      } catch (e) {
        phase = {
          ...state,
          saving: false,
          error:
            e instanceof ConflictError
              ? "The file changed on GitHub while this was open. Close and reopen the card to edit the current version."
              : (e as Error).message,
        };
        paint();
      }
    }

    function saveLabel(): string {
      if (saving()) return "Saving…";
      if (!editing()) return "Save";
      return removing() ? "Delete card" : "Save to GitHub";
    }

    function body() {
      if (phase.kind === "loading") {
        return html`<p class="editor-status">Fetching the file…</p>`;
      }
      if (phase.kind === "failed") {
        // prettier-ignore
        return html`<p class="editor-status">Could not open this card. <a href=${cardSourceUrl(config, card)} target="_blank" rel="noopener">Edit it on GitHub</a> instead.</p>`;
      }
      const state = phase;
      return html`
        <textarea
          class="editor-text"
          spellcheck="false"
          rows=${rowsFor(state.source.text)}
          .value=${state.text}
          @input=${(e: Event) => {
            phase = { ...state, text: (e.target as HTMLTextAreaElement).value };
            paint();
          }}
        ></textarea>
        ${state.reviews === null
          ? nothing
          : html`<label class="editor-keep" ?hidden=${removing()}>
              <input
                type="checkbox"
                .checked=${state.keep}
                @change=${(e: Event) => {
                  phase = {
                    ...state,
                    keep: (e.target as HTMLInputElement).checked,
                  };
                  paint();
                }}
              />
              <span>${keepLabel(state.reviews)}</span>
            </label>`}
      `;
    }

    function view() {
      const error =
        phase.kind === "failed"
          ? phase.message
          : phase.kind === "editing"
          ? phase.error
          : null;
      return html`<div
        class="editor-backdrop"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget && !dirty() && !saving()) {
            finish(null);
          }
        }}
      >
        <div
          class="editor-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Edit card"
        >
          <header class="editor-head">
            <div class="editor-title">
              <h3>Edit card</h3>
              <p class="editor-path">${card.filePath} · ${lineLabel(card)}</p>

            </div>
            <button
              class="editor-close"
              type="button"
              aria-label="Close"
              @click=${() => finish(null)}
            >✕</button>
          </header>
          <div class="editor-body">${body()}</div>
          <p class="editor-error" ?hidden=${error === null}>${error ?? ""}</p>
          <div class="editor-actions">
            <button
              class="btn editor-cancel"
              type="button"
              ?disabled=${saving()}
              @click=${() => finish(null)}
            >Cancel</button>
            <button
              class="btn ${removing() && !saving()
                ? "btn-danger"
                : "btn-primary"} editor-save"
              type="button"
              ?disabled=${!dirty() || saving()}
              @click=${() => void commit()}
            >${saveLabel()}</button>
          </div>
        </div>
      </div>`;
    }

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(host);
    paint();

    void (async () => {
      try {
        const [source, performances] = await Promise.all([
          readCardSource(config, card),
          getAllPerformances(),
        ]);
        const perf = performances.get(card.hash);
        phase = {
          kind: "editing",
          source,
          text: source.text,
          reviews: perf?.reviewCount ?? null,
          keep: perf !== undefined,
          saving: false,
          error: null,
        };
        paint();
        host.querySelector<HTMLTextAreaElement>(".editor-text")?.focus();
      } catch (e) {
        phase = { kind: "failed", message: (e as Error).message };
        paint();
      }
    })();
  });
}

function keepLabel(reviews: number): string {
  const plural = reviews === 1 ? "review" : "reviews";
  return `Keep its scheduling — ${reviews} ${plural} of history, and its place in the queue`;
}

function lineLabel(card: Card): string {
  const [start, end] = card.range;
  return end > start ? `lines ${start}–${end}` : `line ${start}`;
}

/** Big enough to hold the card without scrolling, small enough for a phone. */
function rowsFor(text: string): number {
  return Math.min(Math.max(text.split("\n").length + 1, 4), 16);
}
