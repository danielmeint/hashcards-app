import { Card, DrillSession } from "../types";
import { escapeHtml } from "../escape";
import { loadCachedCards, syncAll } from "../sync";
import { getConfig } from "../github";
import { getAllPerformances, getReviewsSince, loadSession, clearSession } from "../db";
import { todayStr } from "../fsrs";
import {
  getNewCardsPerDay,
  getIntroducedToday,
  selectDueCards,
  countDue,
  remainingBudget,
} from "../new-card-budget";
import {
  SyncStatus,
  getLastPushedAt,
  getLastSyncedAt,
  getSyncStatus,
  onSyncStatus,
} from "../sync-state";
import { syncNotice } from "../sync-notice";

type DeckInfo = {
  /**
   * Identity is the repo path, not the display name. `aws/Networking.md` and
   * `misc/Networking.md` are two decks that happen to be called the same thing,
   * and merging them silently loses one of them.
   */
  path: string;
  name: string;
  /** Directory the file sits in; empty at the repo root. */
  dir: string;
  total: number;
  reviewDue: number;
  /** Genuine supply of unseen cards, before the day's global budget. */
  newCount: number;
};

type DeckGroup = { dir: string; decks: DeckInfo[] };

/**
 * Only one deck list exists at a time, so its subscription can live here rather
 * than being threaded through every internal re-render.
 */
let unsubscribe: (() => void) | null = null;

/**
 * Reviews that have not left the device.
 *
 * Taken from the review log rather than from a flag the app has to remember to
 * set: reviews recorded after the last confirmed push are exactly the ones
 * still owed, and a crash mid-drill cannot lose track of that the way a flag
 * can. No push has ever landed means every review is owed.
 */
async function unsyncedReviewCount(lastPushedAt: string | null): Promise<number> {
  return (await getReviewsSince(lastPushedAt ?? "")).length;
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

  const cards = await loadCachedCards();
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

  // One deck per source file, keyed by path.
  const byFile = new Map<string, Card[]>();
  for (const card of cards) {
    const deckCards = byFile.get(card.filePath);
    if (deckCards) deckCards.push(card);
    else byFile.set(card.filePath, [card]);
  }

  const decks: DeckInfo[] = [];
  for (const [path, deckCards] of byFile) {
    const counts = countDue(deckCards, performances, today);
    decks.push({
      path,
      // Every card in a file shares its deck name, frontmatter override included.
      name: deckCards[0].deckName,
      dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      total: deckCards.length,
      reviewDue: counts.reviewDue,
      newCount: counts.newCount,
    });
  }
  decks.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );

  // Grouped by directory, root first, so the list reads the way the repo looks
  // — and so two decks with the same name are told apart by where they live.
  const groups: DeckGroup[] = [];
  for (const deck of decks) {
    const group = groups.find((g) => g.dir === deck.dir);
    if (group) group.decks.push(deck);
    else groups.push({ dir: deck.dir, decks: [deck] });
  }
  groups.sort((a, b) =>
    a.dir === "" ? -1 : b.dir === "" ? 1 : a.dir.localeCompare(b.dir)
  );

  const totalReviews = decks.reduce((s, d) => s + d.reviewDue, 0);
  // Clamped once, across every deck: the budget is one pool, and the button
  // has to promise what pressing it will actually give you.
  const totalNew = Math.min(
    decks.reduce((s, d) => s + d.newCount, 0),
    remainingBudget(today)
  );
  const totalDue = totalReviews + totalNew;

  const deckRow = (d: DeckInfo) => `
    <div class="deck-card" data-path="${escapeHtml(d.path)}">
      <div class="deck-info">
        <span class="deck-name">${escapeHtml(d.name)}</span>
        <span class="deck-counts">${d.total} cards · ${d.reviewDue} review${d.reviewDue === 1 ? "" : "s"} · ${d.newCount} new</span>
      </div>
      ${d.reviewDue + d.newCount > 0 ? `<button class="btn deck-drill-btn" data-path="${escapeHtml(d.path)}">Drill</button>` : ""}
    </div>
  `;

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
      <div class="sync-status" id="sync-status" hidden>
        <span id="sync-status-text"></span>
        <button id="sync-action" class="btn btn-small" hidden></button>
      </div>
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
        ${groups
          .map(
            (g) =>
              (g.dir ? `<div class="deck-group-name">${escapeHtml(g.dir)}</div>` : "") +
              g.decks.map(deckRow).join("")
          )
          .join("")}
      </div>
    </div>
  `;

  const statusEl = container.querySelector("#sync-status") as HTMLElement;
  const textEl = container.querySelector("#sync-status-text") as HTMLElement;
  const actionBtn = container.querySelector("#sync-action") as HTMLButtonElement;
  const syncBtn = container.querySelector("#sync-btn") as HTMLButtonElement;

  // Read once per render. Progress ticks repaint this line several times a
  // sync, and neither figure can change in between.
  const lastPushedAt = getLastPushedAt();
  const unsynced = await unsyncedReviewCount(lastPushedAt);

  function applyStatus(status: SyncStatus): void {
    const notice = syncNotice({
      status,
      lastSyncedAt: getLastSyncedAt(),
      lastPushedAt,
      unsyncedReviews: unsynced,
      online: navigator.onLine,
    });

    statusEl.hidden = notice === null;
    textEl.textContent = notice?.text ?? "";
    statusEl.classList.toggle("sync-status-error", notice?.level === "error");
    statusEl.classList.toggle("sync-status-warn", notice?.level === "warn");

    actionBtn.hidden = !notice?.action;
    actionBtn.dataset.action = notice?.action ?? "";
    actionBtn.textContent = notice?.action === "sign-in" ? "Sign in" : "Try again";

    const syncing = status.phase === "syncing";
    syncBtn.disabled = syncing;
    syncBtn.textContent = syncing ? "…" : "⟳";
  }

  applyStatus(getSyncStatus());

  actionBtn.addEventListener("click", () => {
    if (actionBtn.dataset.action === "sign-in") onSettings();
    else startSync();
  });

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
      const path = (btn as HTMLElement).dataset.path!;
      const deckCards = cards.filter((c) => c.filePath === path);
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
        <h1>${status.needsSignIn ? "Signed out of GitHub" : "Couldn't load your cards"}</h1>
        <p class="sync-status-error">${escapeHtml(status.message)}</p>
        <div class="empty-actions">
          ${
            status.needsSignIn
              ? `<button id="goto-settings" class="btn btn-primary">Sign in</button>`
              : `<button id="retry-btn" class="btn btn-primary">Try again</button>
                 <button id="goto-settings" class="btn">Settings</button>`
          }
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
