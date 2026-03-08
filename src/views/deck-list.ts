import { Card } from "../types";
import { loadCachedCards, syncCards, fullSync } from "../sync";
import { getConfig } from "../github";
import { getAllPerformances } from "../db";
import { todayStr } from "../fsrs";

type DeckInfo = {
  name: string;
  total: number;
  due: number;
  newCount: number;
};

export async function renderDeckList(
  container: HTMLElement,
  onDrill: (cards: Card[]) => void,
  onSettings: () => void
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

  // Group by deck
  const deckMap = new Map<string, { cards: Card[]; due: number; newCount: number }>();
  for (const card of cards) {
    if (!deckMap.has(card.deckName)) {
      deckMap.set(card.deckName, { cards: [], due: 0, newCount: 0 });
    }
    const deck = deckMap.get(card.deckName)!;
    deck.cards.push(card);

    const perf = performances.get(card.hash);
    if (!perf) {
      deck.newCount++;
      deck.due++;
    } else if (perf.dueDate <= today) {
      deck.due++;
    }
  }

  const decks: DeckInfo[] = [];
  for (const [name, info] of deckMap) {
    decks.push({
      name,
      total: info.cards.length,
      due: info.due,
      newCount: info.newCount,
    });
  }
  decks.sort((a, b) => a.name.localeCompare(b.name));

  const totalDue = decks.reduce((s, d) => s + d.due, 0);

  container.innerHTML = `
    <div class="deck-list-view">
      <div class="deck-list-header">
        <h1>Decks</h1>
        <div class="deck-list-actions">
          <button id="sync-btn" title="Sync">⟳</button>
          <button id="settings-btn" title="Settings">⚙</button>
        </div>
      </div>
      ${
        totalDue > 0
          ? `<button class="drill-all-btn" id="drill-all">Drill All (${totalDue} due)</button>`
          : `<div class="all-caught-up">All caught up!</div>`
      }
      <div class="deck-cards">
        ${decks
          .map(
            (d) => `
          <div class="deck-card" data-deck="${d.name}">
            <div class="deck-info">
              <span class="deck-name">${d.name}</span>
              <span class="deck-counts">${d.total} cards · ${d.due} due · ${d.newCount} new</span>
            </div>
            ${d.due > 0 ? `<button class="deck-drill-btn" data-deck="${d.name}">Drill</button>` : ""}
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;

  // Event handlers
  container.querySelector("#settings-btn")!.addEventListener("click", onSettings);

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
      await syncCards(config);
      await fullSync(config);
      renderDeckList(container, onDrill, onSettings);
    } catch (e) {
      alert(`Sync error: ${(e as Error).message}`);
      btn.disabled = false;
      btn.textContent = "⟳";
    }
  });

  container.querySelector("#drill-all")?.addEventListener("click", async () => {
    const dueCards = await getDueCards(cards, performances, today);
    if (dueCards.length > 0) onDrill(dueCards);
  });

  container.querySelectorAll(".deck-drill-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const deckName = (btn as HTMLElement).dataset.deck!;
      const deckCards = cards.filter((c) => c.deckName === deckName);
      const dueCards = await getDueCards(deckCards, performances, today);
      if (dueCards.length > 0) onDrill(dueCards);
    });
  });
}

async function getDueCards(
  cards: Card[],
  performances: Map<string, { dueDate: string }>,
  today: string
): Promise<Card[]> {
  return cards.filter((card) => {
    const perf = performances.get(card.hash);
    if (!perf) return true; // new card
    return perf.dueDate <= today;
  });
}
