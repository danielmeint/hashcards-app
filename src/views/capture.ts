import { html, nothing, render } from "lit-html";
import { GitHubConfig } from "../github";
import { CaptureResult, CardSyntaxError, createCard } from "../card-edit";
import { settings } from "../settings";
import { syncStateOnly } from "../sync";

/**
 * Writing a card, rather than fixing one.
 *
 * Ideas for cards arrive while reading, not while drilling — which is the one
 * moment the app was never any use for, because getting a card into the
 * collection meant finding the repo, finding the file, and remembering the
 * format by the time you got there.
 *
 * The box is the file format rather than a question field and an answer field.
 * That is not laziness: `C:` cards have no two halves to put in two fields, and
 * a form that can only express `Q:`/`A:` would quietly be a worse authoring
 * tool than the text file it writes to.
 *
 * Resolves with what was written, or `null` if nothing was.
 */

export type Deck = { path: string; name: string };

/**
 * The picker's values are positions in `decks`, not paths. A path is arbitrary
 * text out of someone's repository, so any sentinel spelled like one could
 * collide with a real deck; an index cannot.
 */
const NEW_DECK = "new";

type Phase = { saving: boolean; error: string | null };

export function openCapture(
  config: GitHubConfig,
  decks: Deck[]
): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");

    // Where the last card went, if that deck is still there — a collection
    // with no decks at all has nothing to append to, so the only thing on
    // offer is the first one.
    const at = decks.findIndex((d) => d.path === settings.lastDeckPath.get());
    let target = decks.length === 0 ? NEW_DECK : String(Math.max(at, 0));
    let newPath = "";
    let text = "";
    let phase: Phase = { saving: false, error: null };

    const path = () =>
      target === NEW_DECK
        ? normalisePath(newPath)
        : decks[Number(target)]?.path ?? "";
    const ready = () => text.trim() !== "" && path() !== "" && !phase.saving;

    function paint(): void {
      render(view(), host);
    }

    function finish(result: CaptureResult | null): void {
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (phase.saving) return;
      if (e.key === "Escape" && text.trim() === "") {
        e.preventDefault();
        finish(null);
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready()) {
        e.preventDefault();
        void commit();
      }
    }

    async function commit(): Promise<void> {
      if (!ready()) return;
      phase = { saving: true, error: null };
      paint();
      try {
        const result = await createCard(config, path(), text);
        settings.lastDeckPath.set(result.path);
        // A card written on this device is worth nothing to the others until
        // it is pushed — but the deck list reports sync, so this is not
        // something to hold the sheet open for.
        void syncStateOnly(config);
        finish(result);
      } catch (e) {
        phase = {
          saving: false,
          error:
            e instanceof CardSyntaxError
              ? e.message
              : `Couldn't save: ${(e as Error).message}`,
        };
        paint();
      }
    }

    function deckPicker() {
      return html`<div class="capture-target">
        <select
          class="capture-deck"
          aria-label="Deck"
          ?disabled=${phase.saving}
          @change=${(e: Event) => {
            target = (e.target as HTMLSelectElement).value;
            phase = { ...phase, error: null };
            paint();
          }}
        >
          ${decks.map(
            (deck, i) => html`<option value=${i} ?selected=${String(i) === target}>
              ${deck.name}
            </option>`
          )}
          <option value=${NEW_DECK} ?selected=${target === NEW_DECK}>
            New deck…
          </option>
        </select>
        ${target === NEW_DECK
          ? html`<input
              class="capture-path"
              type="text"
              aria-label="New deck file"
              placeholder="folder/Deck.md"
              spellcheck="false"
              .value=${newPath}
              ?disabled=${phase.saving}
              @input=${(e: Event) => {
                newPath = (e.target as HTMLInputElement).value;
                paint();
              }}
            />`
          : nothing}
      </div>`;
    }

    function view() {
      return html`<div
        class="editor-backdrop"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget && text.trim() === "" && !phase.saving) {
            finish(null);
          }
        }}
      >
        <div
          class="editor-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="New card"
        >
          <header class="editor-head">
            <div class="editor-title">
              <h3>New card</h3>
              <p class="editor-path">
                Appended to the end of the deck
              </p>
            </div>
            <button
              class="editor-close"
              type="button"
              aria-label="Close"
              @click=${() => finish(null)}
            >✕</button>
          </header>
          <div class="editor-body">
            ${deckPicker()}
            <textarea
              class="editor-text capture-text"
              spellcheck="false"
              rows="8"
              placeholder=${PLACEHOLDER}
              .value=${text}
              ?disabled=${phase.saving}
              @input=${(e: Event) => {
                text = (e.target as HTMLTextAreaElement).value;
                phase = { ...phase, error: null };
                paint();
              }}
            ></textarea>
          </div>
          <p class="editor-error" ?hidden=${phase.error === null}>
            ${phase.error ?? ""}
          </p>
          <div class="editor-actions">
            <button
              class="btn"
              type="button"
              ?disabled=${phase.saving}
              @click=${() => finish(null)}
            >Cancel</button>
            <button
              class="btn btn-primary capture-save"
              type="button"
              ?disabled=${!ready()}
              @click=${() => void commit()}
            >${phase.saving ? "Saving…" : "Save to GitHub"}</button>
          </div>
        </div>
      </div>`;
    }

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(host);
    paint();
    host.querySelector<HTMLTextAreaElement>(".capture-text")?.focus();
  });
}

const PLACEHOLDER = `Q: What does S3 stand for?
A: Simple Storage Service

or

C: The capital of [France] is [Paris]`;

/**
 * What the typed path means as a repo path. Leading slashes and a missing
 * extension are the two things people type that GitHub would take literally —
 * `/Notes` is a file called `Notes` at the root of nothing, and the parser only
 * reads `.md`.
 */
export function normalisePath(input: string): string {
  const trimmed = input.trim().replace(/^\/+/, "");
  if (trimmed === "") return "";
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}
