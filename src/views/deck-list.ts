import { Card, DrillSession } from "../types";
import { loadCachedCards, syncAll } from "../sync";
import { getConfig } from "../github";
import { getAllPerformances, loadSession, clearSession } from "../db";
import { todayStr } from "../fsrs";
import { getNewCardsPerDay, getIntroducedToday, selectDueCards, countDue } from "../new-card-budget";
import {
  SyncStatus,
  formatSyncAge,
  getLastSyncedAt,
  getSyncStatus,
  onSyncStatus,
} from "../sync-state";

type DeckInfo = {
  name: string;
  total: number;
  reviewDue: number;
  newCount: number;
};

/**
 * Only one deck list exists at a time, so its subscription can live here rather
 * than being threaded through every internal re-render.
 */
let unsubscribe: (() => void) | null = null;

function escapeHtml(text: string): string {
  const el = document.createElement("div");
  el.textContent = text;
  return el.innerHTML;
}

/** What the status line should say, or null when there is nothing to report. */
function syncLine(status: SyncStatus): { text: string; error: boolean } | null {
  if (status.phase === "syncing") {
    return {
      text: status.detail ? `Syncing — ${status.detail.toLowerCase()}` : "Syncing…",
      error: false,
    };
  }
  if (status.phase === "error") {
    return { text: `Sync failed: ${status.message}`, error: true };
  }
  const last = getLastSyncedAt();
  return last ? { text: `Synced ${formatSyncAge(last)}`, error: false } : null;
}

/**
 * Renders the deck list and returns a teardown. Sync runs behind this view, so
 * counts are painted from cache immediately and refreshed when sync lands.
 */
export async function renderDeckList(
  container: HTMLElement,
  onDrill: (cards: Card[], resume?: DrillSession) => void,
  onSettings: () => void,
  onStats: () => void
): Promise<() => void> {
  unsubscribe?.();
  unsubscribe = null;

  const dispose = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  const refresh = () => {
    renderDeckList(container, onDrill, onSettings, onStats);
  };

  const startSync = () => {
    const config = getConfig();
    if (!config) {
      onSettings();
      return;
    }
    // Fire and forget: progress and failure both arrive through the status.
    syncAll(config);
  };

  const cards = loadCachedCards();
  if (cards.length === 0) {
    renderEmpty(container, onSettings, startSync);
    unsubscribe = onSyncStatus(refresh);
    return dispose;
  }

  const performances = await getAllPerformances();
  const today = todayStr();

  // An interrupted drill is offered back rather than resumed automatically —
  // reopening the app is not always an intent to carry on where you left off.
  const session = await loadSession();
  const byHash = new Map(cards.map((c) => [c.hash, c]));
  const resumable = session
    ? session.queue.filter((hash) => byHash.has(hash))
    : [];
  // A session whose cards have all left the repo can never be resumed.
  if (session && resumable.length === 0) await clearSession();
  const newPerDay = getNewCardsPerDay();
  const introducedToday = getIntroducedToday(today);

  // Group by deck and compute counts
  const deckCardMap = new Map<string, Card[]>();
  for (const card of cards) {
    if (!deckCardMap.has(card.deckName)) {
      deckCardMap.set(card.deckName, []);
    }
    deckCardMap.get(card.deckName)!.push(card);
  }

  const decks: DeckInfo[] = [];
  for (const [name, deckCards] of deckCardMap) {
    const counts = countDue(deckCards, performances, today);
    decks.push({
      name,
      total: deckCards.length,
      reviewDue: counts.reviewDue,
      newCount: counts.newCount,
    });
  }
  decks.sort((a, b) => a.name.localeCompare(b.name));

  const totalReviews = decks.reduce((s, d) => s + d.reviewDue, 0);
  const totalNew = decks.reduce((s, d) => s + d.newCount, 0);
  const totalDue = totalReviews + totalNew;

  container.innerHTML = `
    <div class="deck-list-view">
      <div class="deck-list-header">
        <h1>Decks</h1>
        <div class="deck-list-actions">
          <button id="stats-btn" class="btn" title="Statistics">Stats</button>
          <button id="sync-btn" class="btn" title="Sync">⟳</button>
          <button id="settings-btn" class="btn" title="Settings">⚙</button>
        </div>
      </div>
      <div class="new-budget-status">New today: ${introducedToday}/${newPerDay}</div>
      <div class="sync-status" id="sync-status" hidden></div>
      ${
        resumable.length > 0
          ? `
        <div class="resume-banner">
          <div class="resume-text">
            <strong>Session in progress</strong>
            <span>${resumable.length} card${resumable.length === 1 ? "" : "s"} left</span>
          </div>
          <div class="resume-actions">
            <button id="resume-btn" class="btn btn-primary">Resume</button>
            <button id="discard-btn" class="btn">Discard</button>
          </div>
        </div>
      `
          : ""
      }
      ${
        totalDue > 0
          ? `<button class="btn btn-primary drill-all-btn" id="drill-all">Drill All (${totalReviews} review${totalReviews === 1 ? "" : "s"}, ${totalNew} new)</button>`
          : `<div class="all-caught-up">All caught up!</div>`
      }
      <div class="deck-cards">
        ${decks
          .map(
            (d) => `
          <div class="deck-card" data-deck="${d.name}">
            <div class="deck-info">
              <span class="deck-name">${d.name}</span>
              <span class="deck-counts">${d.total} cards · ${d.reviewDue} review${d.reviewDue === 1 ? "" : "s"} · ${d.newCount} new</span>
            </div>
            ${d.reviewDue + d.newCount > 0 ? `<button class="btn deck-drill-btn" data-deck="${d.name}">Drill</button>` : ""}
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;

  const statusEl = container.querySelector("#sync-status") as HTMLElement;
  const syncBtn = container.querySelector("#sync-btn") as HTMLButtonElement;

  function applyStatus(status: SyncStatus): void {
    const line = syncLine(status);
    statusEl.hidden = line === null;
    statusEl.textContent = line?.text ?? "";
    statusEl.classList.toggle("sync-status-error", line?.error === true);

    const syncing = status.phase === "syncing";
    syncBtn.disabled = syncing;
    syncBtn.textContent = syncing ? "…" : "⟳";
  }

  applyStatus(getSyncStatus());

  // Progress ticks patch the status line; anything else changes the counts, so
  // re-render rather than trying to reconcile them by hand.
  unsubscribe = onSyncStatus((status) => {
    if (status.phase === "syncing") applyStatus(status);
    else refresh();
  });

  // Event handlers
  container.querySelector("#settings-btn")!.addEventListener("click", onSettings);
  container.querySelector("#stats-btn")!.addEventListener("click", onStats);
  syncBtn.addEventListener("click", startSync);

  container.querySelector("#resume-btn")?.addEventListener("click", () => {
    // Completed cards travel too: undo needs to resolve any card in the session.
    const hashes = new Set([...session!.queue, ...session!.completed]);
    const sessionCards = cards.filter((c) => hashes.has(c.hash));
    onDrill(sessionCards, session!);
  });

  container.querySelector("#discard-btn")?.addEventListener("click", async () => {
    await clearSession();
    refresh();
  });

  container.querySelector("#drill-all")?.addEventListener("click", async () => {
    const due = selectDueCards(cards, performances, today);
    if (due.length > 0) onDrill(due);
  });

  container.querySelectorAll(".deck-drill-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const deckName = (btn as HTMLElement).dataset.deck!;
      const deckCards = cards.filter((c) => c.deckName === deckName);
      const due = selectDueCards(deckCards, performances, today);
      if (due.length > 0) onDrill(due);
    });
  });

  return dispose;
}

/**
 * No cached cards. Which of the three reasons applies is the whole message:
 * a first sync in flight is not the same as an unconfigured app, and neither
 * is a sync that failed.
 */
function renderEmpty(
  container: HTMLElement,
  onSettings: () => void,
  onRetry: () => void
): void {
  const status = getSyncStatus();

  const body =
    status.phase === "syncing"
      ? `
        <h1>Loading your cards…</h1>
        <p>${escapeHtml(status.detail ?? "Fetching from GitHub")}</p>
      `
      : status.phase === "error"
      ? `
        <h1>Couldn't load your cards</h1>
        <p class="sync-status-error">${escapeHtml(status.message)}</p>
        <div class="empty-actions">
          <button id="retry-btn" class="btn btn-primary">Try again</button>
          <button id="goto-settings" class="btn">Settings</button>
        </div>
      `
      : `
        <h1>No cards loaded</h1>
        <p>Configure your GitHub repo and sync first.</p>
        <div class="empty-actions">
          <button id="goto-settings" class="btn">Settings</button>
        </div>
      `;

  container.innerHTML = `<div class="deck-list-view deck-list-empty">${body}</div>`;
  container.querySelector("#goto-settings")?.addEventListener("click", onSettings);
  container.querySelector("#retry-btn")?.addEventListener("click", onRetry);
}
