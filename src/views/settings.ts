import { html, nothing, render } from "lit-html";
import {
  getConfig,
  getIntervalFuzz,
  setIntervalFuzz,
  getHapticFeedback,
  setHapticFeedback,
} from "../github";
import { loadCredential } from "../auth";
import { signInAvailable } from "../github-app";
import {
  getNewCardsPerDay,
  setNewCardsPerDay,
  getIntroducedToday,
  resetIntroduced,
} from "../new-card-budget";
import { todayStr } from "../fsrs";
import { getTheme, setTheme, Theme } from "../theme";
import { adoptRepo, syncAll, getCachedCards } from "../sync";
import { getSyncStatus, onSyncStatus } from "../sync-state";
import { renderAuthPanel } from "./auth-panel";

/**
 * Settings, in two halves: how the app connects to GitHub (delegated to
 * `auth-panel`, which owns the credential and the repo) and the preferences
 * that are purely local.
 *
 * Preferences save the moment they change. They used to be collected off the
 * DOM by a `savePrefs()` that ran on Sync and on Back, which meant the only
 * ways out of this screen were also the only ways to keep a change — true
 * today and one new exit away from being false.
 */
export async function renderSettings(
  container: HTMLElement,
  onDone: () => void,
  notice?: string
): Promise<void> {
  const config = getConfig();
  const credential = await loadCredential();
  const today = todayStr();
  const isFirstRun = !credential || !config;

  const state = {
    newPerDay: getNewCardsPerDay(),
    introducedToday: getIntroducedToday(today),
    status: "" as string,
    syncing: false,
  };

  const paint = () => render(view(), container);

  function setNewPerDay(raw: string): void {
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) return;
    setNewCardsPerDay(value);
    state.newPerDay = value;
    paint();
  }

  async function sync(adopting = false): Promise<void> {
    const cfg = getConfig();
    if (!cfg) {
      state.status = "Choose a repository first.";
      paint();
      return;
    }
    state.syncing = true;
    paint();

    // The same runner the deck list uses, so this cannot race a background sync
    // and so a success here also updates the "last synced" line. Its progress is
    // echoed inline, because here the user is watching.
    const unwatch = onSyncStatus((s) => {
      if (s.phase === "syncing") {
        state.status = s.detail ? `${s.detail}…` : "Syncing…";
        paint();
      }
    });

    try {
      const ok = await (adopting ? adoptRepo(cfg) : syncAll(cfg));
      if (ok) {
        const count = getCachedCards()?.length ?? 0;
        state.status = `Done! ${count} cards synced.`;
        if (isFirstRun) onDone();
      } else {
        const status = getSyncStatus();
        state.status =
          status.phase === "error" ? status.message : "Sync failed.";
      }
    } finally {
      unwatch();
      state.syncing = false;
      paint();
    }
  }

  function view() {
    return html`<div class="settings-view">
      <h1>Settings</h1>
      ${notice ? html`<p class="settings-notice">${notice}</p>` : nothing}
      ${isFirstRun ? welcome(credential !== null) : nothing}
      <section class="settings-section">
        <h2>GitHub</h2>
        <div id="auth-host"></div>
      </section>
      <section class="settings-section">
        <h2>Reviewing</h2>
        <div class="field-group">
          <label for="new-per-day">New cards per day</label>
          <input
            type="number"
            id="new-per-day"
            .value=${String(state.newPerDay)}
            min="1"
            max="999"
            @change=${(e: Event) =>
              setNewPerDay((e.target as HTMLInputElement).value)}
          />
          <div class="new-cards-status">
            <span id="new-cards-counter"
              >${`${state.introducedToday}/${state.newPerDay} introduced today`}</span
            >
            ${state.introducedToday > 0
              ? html`<button
                  type="button"
                  id="reset-new-btn"
                  class="reset-btn"
                  @click=${() => {
                    resetIntroduced();
                    state.introducedToday = 0;
                    paint();
                  }}
                >
                  Reset
                </button>`
              : nothing}
          </div>
        </div>
        <div class="field-group">
          <label for="theme">Theme</label>
          <select
            id="theme"
            @change=${(e: Event) =>
              setTheme((e.target as HTMLSelectElement).value as Theme)}
          >
            ${THEMES.map(
              ([value, label]) =>
                html`<option value=${value} ?selected=${value === getTheme()}>
                  ${label}
                </option>`
            )}
          </select>
        </div>
        <label class="toggle-label">
          <input
            type="checkbox"
            id="interval-fuzz"
            .checked=${getIntervalFuzz()}
            @change=${(e: Event) =>
              setIntervalFuzz((e.target as HTMLInputElement).checked)}
          />
          Interval fuzz (vary intervals slightly to avoid clustering)
        </label>
        <label class="toggle-label">
          <input
            type="checkbox"
            id="haptic-feedback"
            .checked=${getHapticFeedback()}
            @change=${(e: Event) =>
              setHapticFeedback((e.target as HTMLInputElement).checked)}
          />
          Haptic feedback on grade and swipe
        </label>
      </section>
      <div class="settings-buttons">
        <button
          type="button"
          id="sync-btn"
          class="btn"
          ?disabled=${state.syncing}
          @click=${() => void sync()}
        >
          Sync Now
        </button>
        ${config
          ? html`<button type="button" id="back-btn" class="btn" @click=${onDone}>
              Back to Decks
            </button>`
          : nothing}
      </div>
      <div id="settings-status">${state.status}</div>
      <div class="settings-footer">
        <div class="settings-version">hashcards ${__COMMIT_HASH__}</div>
        <a
          href="https://github.com/danielmeint/hashcards-app"
          target="_blank"
          rel="noopener"
          >GitHub</a
        >
      </div>
    </div>`;
  }

  paint();

  // A working credential pointed at a repository is the moment there is
  // something to fetch, so fetch it — on a first run that is the whole
  // remaining step, and the deck list is what should come next. Fetching is the
  // right thing to do the moment there is a repo to fetch from; writing to it
  // is not, until the user has actually drilled cards that came out of it, so
  // this is `adoptRepo` rather than a full sync.
  await renderAuthPanel(
    container.querySelector("#auth-host") as HTMLElement,
    () => {
      if (getConfig()) void sync(true);
    }
  );
}

const THEMES: [Theme, string][] = [
  ["system", "Match system"],
  ["light", "Light"],
  ["dark", "Dark"],
];

function welcome(signedIn: boolean) {
  const steps = signInAvailable()
    ? html`<ol>
        <li>
          Create a GitHub repo with <code>.md</code> flashcard files
          (<a
            href="https://github.com/eudoxia0/hashcards#format"
            target="_blank"
            rel="noopener"
            >card format</a
          >)
        </li>
        <li>
          ${signedIn
            ? "Pick that repo below"
            : "Sign in with GitHub below and pick that repo"}
        </li>
      </ol>`
    : html`<ol>
        <li>
          Create a GitHub repo with <code>.md</code> flashcard files
          (<a
            href="https://github.com/eudoxia0/hashcards#format"
            target="_blank"
            rel="noopener"
            >card format</a
          >)
        </li>
        <li>
          Generate a
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noopener"
            >fine-grained PAT</a
          >
          — select only your repo, grant
          <strong>Contents: Read and write</strong>
        </li>
        <li>Enter your details below and click <strong>Connect</strong></li>
      </ol>`;

  return html`<div class="welcome-banner">
    <p>
      <strong>Hashcards</strong> is a spaced repetition flashcard app. Cards live
      as <code>.md</code> files in a GitHub repo, and the app syncs them via the
      GitHub API.
    </p>
    <p><strong>Get started:</strong></p>
    ${steps}
  </div>`;
}
