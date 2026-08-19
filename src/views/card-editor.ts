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
import { escapeHtml } from "../escape";

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
export function openCardEditor(
  card: Card,
  config: GitHubConfig
): Promise<EditResult | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "editor-backdrop";
    backdrop.innerHTML = `
      <div class="editor-sheet" role="dialog" aria-modal="true" aria-label="Edit card">
        <header class="editor-head">
          <div class="editor-title">
            <h3>Edit card</h3>
            <p class="editor-path">${escapeHtml(card.filePath)} · ${lineLabel(
              card
            )}</p>
          </div>
          <button class="editor-close" type="button" aria-label="Close">✕</button>
        </header>
        <div class="editor-body">
          <p class="editor-status">Fetching the file…</p>
        </div>
        <p class="editor-error" hidden></p>
        <div class="editor-actions">
          <button class="btn editor-cancel" type="button">Cancel</button>
          <button class="btn btn-primary editor-save" type="button" disabled>Save</button>
        </div>
      </div>
    `;

    const $ = <T extends Element>(sel: string) => backdrop.querySelector(sel) as T;
    const body = $<HTMLDivElement>(".editor-body");
    const errorLine = $<HTMLParagraphElement>(".editor-error");
    const save = $<HTMLButtonElement>(".editor-save");
    const cancel = $<HTMLButtonElement>(".editor-cancel");
    const close = $<HTMLButtonElement>(".editor-close");

    let source: CardSource | null = null;
    let textarea: HTMLTextAreaElement | null = null;
    let keep: HTMLInputElement | null = null;
    let saving = false;

    const dirty = () =>
      source !== null && textarea !== null && textarea.value !== source.text;

    function finish(result: EditResult | null): void {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (saving) return;
      // Escape gives up the sheet, but not typing that is not saved anywhere
      // else — Cancel is one tap away and says what it does.
      if (e.key === "Escape" && !dirty()) {
        e.preventDefault();
        finish(null);
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !save.disabled) {
        e.preventDefault();
        void commit();
      }
    }

    function showError(message: string): void {
      errorLine.textContent = message;
      errorLine.hidden = false;
    }

    function refreshSave(): void {
      if (!textarea) return;
      const removing = textarea.value.trim() === "";
      save.textContent = removing ? "Delete card" : "Save to GitHub";
      save.classList.toggle("btn-danger", removing);
      save.classList.toggle("btn-primary", !removing);
      save.disabled = !dirty();
      // An emptied box is a deletion, and there is no card left for the
      // scheduling to be kept on.
      const choice = backdrop.querySelector<HTMLElement>(".editor-keep");
      if (choice) choice.hidden = removing;
    }

    async function commit(): Promise<void> {
      if (!source || !textarea || saving) return;
      saving = true;
      save.disabled = true;
      cancel.disabled = true;
      save.textContent = "Saving…";
      errorLine.hidden = true;
      try {
        const result = await commitCardEdit(
          config,
          card,
          source,
          textarea.value,
          { keepScheduling: keep?.checked ?? false }
        );
        // Scheduling that moved to a new hash only exists on this device until
        // it is pushed. Not waited on: the deck list reports sync, and this
        // sheet is finished either way.
        void syncStateOnly(config);
        finish(result);
      } catch (e) {
        saving = false;
        cancel.disabled = false;
        showError(
          e instanceof ConflictError
            ? "The file changed on GitHub while this was open. Close and reopen the card to edit the current version."
            : (e as Error).message
        );
        refreshSave();
      }
    }

    cancel.addEventListener("click", () => finish(null));
    close.addEventListener("click", () => finish(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && !dirty() && !saving) finish(null);
    });
    save.addEventListener("click", () => void commit());
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);

    void (async () => {
      try {
        const [fetched, performances] = await Promise.all([
          readCardSource(config, card),
          getAllPerformances(),
        ]);
        source = fetched;
        const perf = performances.get(card.hash);
        body.innerHTML = `
          <textarea class="editor-text" spellcheck="false" rows="${rowsFor(
            fetched.text
          )}"></textarea>
          ${
            perf
              ? `<label class="editor-keep">
                   <input type="checkbox" checked>
                   <span>Keep its scheduling — ${perf.reviewCount} review${
                  perf.reviewCount === 1 ? "" : "s"
                } of history, and its place in the queue</span>
                 </label>`
              : ""
          }
        `;
        textarea = $<HTMLTextAreaElement>(".editor-text");
        keep = backdrop.querySelector(".editor-keep input");
        textarea.value = fetched.text;
        textarea.addEventListener("input", refreshSave);
        refreshSave();
        textarea.focus();
      } catch (e) {
        body.innerHTML = `<p class="editor-status">Could not open this card. <a href="${cardSourceUrl(
          config,
          card
        )}" target="_blank" rel="noopener">Edit it on GitHub</a> instead.</p>`;
        showError((e as Error).message);
      }
    })();
  });
}

function lineLabel(card: Card): string {
  const [start, end] = card.range;
  return end > start ? `lines ${start}–${end}` : `line ${start}`;
}

/** Big enough to hold the card without scrolling, small enough for a phone. */
function rowsFor(text: string): number {
  return Math.min(Math.max(text.split("\n").length + 1, 4), 16);
}
