import { Card } from "../types";
import { loadCachedCards, syncCards, fullSync } from "../sync";
import { getConfig } from "../github";
import { getAllPerformances } from "../db";
import { todayStr } from "../fsrs";
import { getNewCardsPerDay, getIntroducedToday, selectDueCards, countDue } from "../new-card-budget";

type DeckInfo = {
  name: string;
  total: number;
  reviewDue: number;
  newCount: number;
};

export async function renderDeckList(
  container: HTMLElement,
  onDrill: (cards: Card[]) => void,
  onSettings: () => void,
  onStats: () => void
): Promise<void> {
  const cards = loadCachedCards();
  if (cards.length === 0) {
    container.innerHTML = `
      <div class="deck-list-view">
        <h1>No cards loaded</h1>
        <p>Configure your GitHub repo and sync first.</p>
        <button id="goto-settings">Settings</button>
      </div>
    `;
    container.querySelector("#goto-settings")!.addEventListener("click", onSettings);
    return;
  }

  const performances = await getAllPerformances();
  const today = todayStr();
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
          <button id="stats-btn" title="Statistics">Stats</button>
          <button id="sync-btn" title="Sync">⟳</button>
          <button id="settings-btn" title="Settings">⚙</button>
        </div>
      </div>
      <div class="new-budget-status">New today: ${introducedToday}/${newPerDay}</div>
      ${
        totalDue > 0
          ? `<button class="drill-all-btn" id="drill-all">Drill All (${totalReviews} review${totalReviews === 1 ? "" : "s"}, ${totalNew} new)</button>`
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
            ${d.reviewDue + d.newCount > 0 ? `<button class="deck-drill-btn" data-deck="${d.name}">Drill</button>` : ""}
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;

  // Event handlers
  container.querySelector("#settings-btn")!.addEventListener("click", onSettings);
  container.querySelector("#stats-btn")!.addEventListener("click", onStats);

  container.querySelector("#sync-btn")!.addEventListener("click", async () => {
    const config = getConfig();
    if (!config) {
      onSettings();
      return;
    }
    const btn = container.querySelector("#sync-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "...";
    try {
      await syncCards(config, (p) => {
        btn.textContent = p.current && p.total ? `${p.current}/${p.total}` : "...";
      });
      await fullSync(config);
      renderDeckList(container, onDrill, onSettings, onStats);
    } catch (e) {
      alert(`Sync error: ${(e as Error).message}`);
      btn.disabled = false;
      btn.textContent = "⟳";
    }
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
}
