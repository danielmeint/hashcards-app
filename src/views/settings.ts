import { html, nothing, render } from "lit-html";
import {
  getConfig,
  repoKey,
  writableRepos,
  getIntervalFuzz,
  setIntervalFuzz,
  getDesiredRetention,
  setDesiredRetention,
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
import { renderCollections } from "./collections";
import { icon } from "./icons";

/** Presets across the range the setting allows (`MIN_RETENTION`–`MAX_RETENTION`). */
const RETENTIONS = [0.8, 0.85, 0.9, 0.93, 0.95];

/** The presets, plus the stored value if it is none of them, so it shows as chosen. */
function retentionChoices(): number[] {
  const current = getDesiredRetention();
  return RETENTIONS.includes(current)
    ? RETENTIONS
    : [...RETENTIONS, current].sort((a, b) => a - b);
}

/**
 * Settings: how the app connects to GitHub (delegated to `auth-panel`, which
 * owns the credential and the repo), then the preferences, in the two kinds
 * there are. **Collection** settings (new cards per day, retention, fuzz) are
 * the collection's, in its `hashcards.toml`, and every device follows them.
 * **This device** (haptics, theme) stays in this browser.
 *
 * Preferences save the moment they change. They used to be collected off the
 * DOM by a `savePrefs()` that ran on Sync and on Back, which meant the only
 * ways out of this screen were also the only ways to keep a change — true
 * today and one new exit away from being false. Collection settings are kept
 * here at once and written to the repo on leaving the screen (`pushSettings`,
 * from `main.ts`), or by the next sync if that fails.
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

  /** One segmented control: a row of choices, one of them pressed. */
  function segmented<T>(
    id: string,
    label: string,
    choices: [T, string][],
    current: T,
    choose: (value: T) => void
  ) {
    return html`<div class="segmented" id=${id} role="group" aria-label=${label}>
      ${choices.map(
        ([value, text]) => html`<button
          type="button"
          data-value=${String(value)}
          aria-pressed=${value === current ? "true" : "false"}
          @click=${() => {
            choose(value);
            paint();
          }}
        >
          ${text}
        </button>`
      )}
    </div>`;
  }

  function toggle(id: string, label: string, on: boolean, set: (on: boolean) => void) {
    return html`<button
      type="button"
      class="switch"
      id=${id}
      role="switch"
      aria-label=${label}
      aria-checked=${on ? "true" : "false"}
      @click=${() => {
        set(!on);
        paint();
      }}
    ></button>`;
  }

  function view() {
    const retention = getDesiredRetention();
    return html`<div class="page settings-view">
      <header class="page-head">
        ${config
          ? html`<button
              type="button"
              id="back-btn"
              class="icon-btn"
              aria-label="Back"
              title="Back"
              @click=${onDone}
            >
              ${icon("back")}<span class="icon-btn-label">Today</span>
            </button>`
          : nothing}
        <h1>Settings</h1>
      </header>
      ${notice
        ? html`<p class="notice notice-warn settings-notice">${notice}</p>`
        : nothing}
      ${isFirstRun ? welcome(credential !== null) : nothing}
      <section class="group">
        <h2 class="group-title">GitHub</h2>
        <div id="auth-host"></div>
        <p class="group-note" id="settings-status" role="status">${state.status}</p>
      </section>
      <section class="group">
        <h2 class="group-title">Collections</h2>
        <div id="collections-host"></div>
      </section>
      <section class="group" id="collection-settings">
        <h2 class="group-title">Collection</h2>
        <p class="group-caption" id="collection-caption">${collectionCaption()}</p>
        <div class="list">
          <div class="row">
            <span class="row-text">
              <label class="row-title" for="new-per-day">New cards per day</label>
              <span class="row-sub">
                <span id="new-cards-counter"
                  >${`${state.introducedToday} of ${state.newPerDay} introduced today`}</span
                >${state.introducedToday > 0
                  ? html`<button
                      type="button"
                      id="reset-new-btn"
                      class="link-btn reset-btn"
                      @click=${() => {
                        resetIntroduced();
                        state.introducedToday = 0;
                        paint();
                      }}
                    >
                      Reset
                    </button>`
                  : nothing}
              </span>
            </span>
            <div class="stepper">
              <button
                type="button"
                aria-label="Fewer"
                ?disabled=${state.newPerDay <= 1}
                @click=${() => setNewPerDay(String(state.newPerDay - 1))}
              >
                −
              </button>
              <input
                type="number"
                id="new-per-day"
                inputmode="numeric"
                .value=${String(state.newPerDay)}
                min="1"
                max="999"
                @change=${(e: Event) =>
                  setNewPerDay((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                aria-label="More"
                ?disabled=${state.newPerDay >= 999}
                @click=${() => setNewPerDay(String(state.newPerDay + 1))}
              >
                +
              </button>
            </div>
          </div>
          <div class="row row-stack">
            <div class="row-line">
              <span>Desired retention</span>
              <strong>${`${Math.round(retention * 100)}%`}</strong>
            </div>
            ${segmented(
              "desired-retention",
              "Desired retention",
              retentionChoices().map((v): [number, string] => [
                v,
                `${Math.round(v * 100)}%`,
              ]),
              retention,
              setDesiredRetention
            )}
            <p class="row-sub">
              How likely you should be to remember a card when it comes due.
              Higher means more reviews; it changes future intervals, not past
              ones.
            </p>
          </div>
          <div class="row">
            <span class="row-text">
              <span>Interval fuzz</span>
              <span class="row-sub">Spread reviews so they don't bunch up</span>
            </span>
            ${toggle("interval-fuzz", "Interval fuzz", getIntervalFuzz(), setIntervalFuzz)}
          </div>
        </div>
      </section>
      <section class="group" id="device-settings">
        <h2 class="group-title">This device</h2>
        <div class="list">
          <div class="row">
            <span class="row-text">
              <span>Haptic feedback</span>
              <span class="row-sub">On grade and swipe</span>
            </span>
            ${toggle(
              "haptic-feedback",
              "Haptic feedback",
              getHapticFeedback(),
              setHapticFeedback
            )}
          </div>
          <div class="row theme-row">
            <span class="row-text">Theme</span>
            ${segmented("theme", "Theme", THEMES, getTheme(), setTheme)}
          </div>
        </div>
      </section>
      <footer class="settings-footer">
        <span class="settings-version">hashcards ${__COMMIT_HASH__}</span>
        <span aria-hidden="true">·</span>
        <a
          href="https://github.com/danielmeint/hashcards-app"
          target="_blank"
          rel="noopener"
          >Source on GitHub</a
        >
      </footer>
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
      collections();
    },
    () => sync()
  );

  // Re-rendered whenever the connection panel changes the list underneath it —
  // signing in and picking a repository adds the first entry.
  function collections(): void {
    const host = container.querySelector("#collections-host");
    if (host) renderCollections(host as HTMLElement, paint);
  }
  collections();
}

/**
 * Where the Collection settings live, so the split from This device is not
 * left to be guessed. Which collection only when there is a choice: the
 * settings are the first writable one's (`getConfig`), and with two of them
 * that is worth saying.
 */
function collectionCaption(): string {
  const writable = writableRepos();
  const config = getConfig();
  if (writable.length > 1 && config) {
    return `Saved in ${repoKey(config)}'s hashcards.toml, and shared by your devices.`;
  }
  return "Saved in your collection's hashcards.toml, and shared by your devices.";
}

const THEMES: [Theme, string][] = [
  ["system", "System"],
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
