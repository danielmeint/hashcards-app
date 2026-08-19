import { getConfig, getIntervalFuzz, setIntervalFuzz, getHapticFeedback, setHapticFeedback } from "../github";
import { loadCredential } from "../auth";
import { signInAvailable } from "../github-app";
import { getNewCardsPerDay, setNewCardsPerDay, getIntroducedToday, resetIntroduced } from "../new-card-budget";
import { todayStr } from "../fsrs";
import { getTheme, setTheme, Theme } from "../theme";
import { syncAll, getCachedCards } from "../sync";
import { getSyncStatus, onSyncStatus } from "../sync-state";
import { renderAuthPanel } from "./auth-panel";
import { escapeHtml } from "../escape";

/**
 * Settings, in two halves: how the app connects to GitHub (delegated to
 * `auth-panel`, which owns the credential and the repo) and the preferences
 * that are purely local.
 */
export async function renderSettings(
  container: HTMLElement,
  onDone: () => void,
  notice?: string
): Promise<void> {
  const config = getConfig();
  const credential = await loadCredential();
  const newPerDay = getNewCardsPerDay();
  const today = todayStr();
  const introducedToday = getIntroducedToday(today);
  const fuzzOn = getIntervalFuzz();
  const hapticOn = getHapticFeedback();
  const theme = getTheme();

  const isFirstRun = !credential || !config;

  container.innerHTML = `
    <div class="settings-view">
      <h1>Settings</h1>
      ${notice ? `<p class="settings-notice">${escapeHtml(notice)}</p>` : ""}
      ${isFirstRun ? welcome(credential !== null) : ""}
      <section class="settings-section">
        <h2>GitHub</h2>
        <div id="auth-host"></div>
      </section>
      <section class="settings-section">
        <h2>Reviewing</h2>
        <div class="field-group">
          <label for="new-per-day">New cards per day</label>
          <input type="number" id="new-per-day" value="${newPerDay}" min="1" max="999" />
          <div class="new-cards-status">
            <span id="new-cards-counter">${introducedToday}/${newPerDay} introduced today</span>
            ${introducedToday > 0 ? `<button type="button" id="reset-new-btn" class="reset-btn">Reset</button>` : ""}
          </div>
        </div>
        <div class="field-group">
          <label for="theme">Theme</label>
          <select id="theme">
            ${(["system", "light", "dark"] as Theme[])
              .map(
                (t) =>
                  `<option value="${t}"${t === theme ? " selected" : ""}>${
                    t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"
                  }</option>`
              )
              .join("")}
          </select>
        </div>
        <label class="toggle-label">
          <input type="checkbox" id="interval-fuzz" ${fuzzOn ? "checked" : ""} />
          Interval fuzz (vary intervals slightly to avoid clustering)
        </label>
        <label class="toggle-label">
          <input type="checkbox" id="haptic-feedback" ${hapticOn ? "checked" : ""} />
          Haptic feedback on grade and swipe
        </label>
      </section>
      <div class="settings-buttons">
        <button type="button" id="sync-btn" class="btn">Sync Now</button>
        ${config ? '<button type="button" id="back-btn" class="btn">Back to Decks</button>' : ""}
      </div>
      <div id="settings-status"></div>
      <div class="settings-footer">
        <div class="settings-version">hashcards ${__COMMIT_HASH__}</div>
        <a href="https://github.com/danielmeint/hashcards-app" target="_blank" rel="noopener">GitHub</a>
      </div>
    </div>
  `;

  const statusEl = container.querySelector("#settings-status") as HTMLElement;

  function savePrefs(): void {
    const val = parseInt((container.querySelector("#new-per-day") as HTMLInputElement).value, 10);
    if (val > 0) setNewCardsPerDay(val);
    setIntervalFuzz((container.querySelector("#interval-fuzz") as HTMLInputElement).checked);
    setHapticFeedback((container.querySelector("#haptic-feedback") as HTMLInputElement).checked);
  }

  container.querySelector("#theme")!.addEventListener("change", (e) => {
    setTheme((e.target as HTMLSelectElement).value as Theme);
  });

  async function sync(): Promise<void> {
    const cfg = getConfig();
    if (!cfg) {
      statusEl.textContent = "Choose a repository first.";
      return;
    }
    const syncBtn = container.querySelector("#sync-btn") as HTMLButtonElement;
    syncBtn.disabled = true;
    savePrefs();

    // The same runner the deck list uses, so this cannot race a background sync
    // and so a success here also updates the "last synced" line. Its progress is
    // echoed inline, because here the user is watching.
    const unwatch = onSyncStatus((s) => {
      if (s.phase === "syncing") {
        statusEl.textContent = s.detail ? `${s.detail}…` : "Syncing…";
      }
    });

    try {
      const ok = await syncAll(cfg);
      if (ok) {
        const count = getCachedCards()?.length ?? 0;
        statusEl.textContent = `Done! ${count} cards synced.`;
        if (isFirstRun) onDone();
      } else {
        const status = getSyncStatus();
        statusEl.textContent =
          status.phase === "error" ? status.message : "Sync failed.";
      }
    } finally {
      unwatch();
      syncBtn.disabled = false;
    }
  }

  container.querySelector("#sync-btn")!.addEventListener("click", () => void sync());

  container.querySelector("#reset-new-btn")?.addEventListener("click", () => {
    resetIntroduced();
    const counterEl = container.querySelector("#new-cards-counter") as HTMLElement;
    const newPerDayVal = (container.querySelector("#new-per-day") as HTMLInputElement).value;
    counterEl.textContent = `0/${newPerDayVal} introduced today`;
    container.querySelector("#reset-new-btn")?.remove();
  });

  container.querySelector("#back-btn")?.addEventListener("click", () => {
    savePrefs();
    onDone();
  });

  // A working credential pointed at a repository is the moment there is
  // something to fetch, so fetch it — on a first run that is the whole
  // remaining step, and the deck list is what should come next.
  await renderAuthPanel(container.querySelector("#auth-host") as HTMLElement, () => {
    if (getConfig()) void sync();
  });
}

function welcome(signedIn: boolean): string {
  const steps = signInAvailable()
    ? `
      <ol>
        <li>Create a GitHub repo with <code>.md</code> flashcard files (<a href="https://github.com/eudoxia0/hashcards#format" target="_blank" rel="noopener">card format</a>)</li>
        <li>${
          signedIn
            ? "Pick that repo below"
            : "Sign in with GitHub below and pick that repo"
        }</li>
      </ol>
    `
    : `
      <ol>
        <li>Create a GitHub repo with <code>.md</code> flashcard files (<a href="https://github.com/eudoxia0/hashcards#format" target="_blank" rel="noopener">card format</a>)</li>
        <li>Generate a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained PAT</a> — select only your repo, grant <strong>Contents: Read and write</strong></li>
        <li>Enter your details below and click <strong>Connect</strong></li>
      </ol>
    `;
  return `
    <div class="welcome-banner">
      <p><strong>Hashcards</strong> is a spaced repetition flashcard app. Cards live as <code>.md</code> files in a GitHub repo, and the app syncs them via the GitHub API.</p>
      <p><strong>Get started:</strong></p>
      ${steps}
    </div>
  `;
}
