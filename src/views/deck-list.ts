import { Card } from "../types";
import { loadCachedCards, syncCards, fullSync } from "../sync";
import { getConfig, getNewCardsPerDay, getNewCardsIntroducedToday, recordNewCardsIntroduced } from "../github";
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
  const newPerDay = getNewCardsPerDay();
  const introducedToday = getNewCardsIntroducedToday(today);
  const remainingNewBudget = Math.max(0, newPerDay - introducedToday);

  // Group by deck
  const deckMap = new Map<string, { cards: Card[]; reviewDue: number; newCount: number }>();
  for (const card of cards) {
    if (!deckMap.has(card.deckName)) {
      deckMap.set(card.deckName, { cards: [], reviewDue: 0, newCount: 0 });
    }
    const deck = deckMap.get(card.deckName)!;
    deck.cards.push(card);

    const perf = performances.get(card.hash);
    if (!perf) {
      deck.newCount++;
    } else if (perf.dueDate <= today) {
      deck.reviewDue++;
    }
  }

  // Apply global new cards/day limit across decks
  let newBudget = remainingNewBudget;
  const decks: DeckInfo[] = [];
  for (const [name, info] of deckMap) {
    const cappedNew = Math.min(info.newCount, newBudget);
    newBudget -= cappedNew;
    decks.push({
      name,
      total: info.cards.length,
      due: info.reviewDue + cappedNew,
      newCount: cappedNew,
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
      await syncCards(config, (p) => {
        btn.textContent = p.current && p.total ? `${p.current}/${p.total}` : "...";
      });
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

function getDueCards(
  cards: Card[],
  performances: Map<string, { dueDate: string }>,
  today: string
): Card[] {
  const newPerDay = getNewCardsPerDay();
  const introducedToday = getNewCardsIntroducedToday(today);
  const remainingNewBudget = Math.max(0, newPerDay - introducedToday);

  const reviewDue: Card[] = [];
  const newCards: Card[] = [];

  for (const card of cards) {
    const perf = performances.get(card.hash);
    if (!perf) {
      newCards.push(card);
    } else if (perf.dueDate <= today) {
      reviewDue.push(card);
    }
  }

  const introducedNow = newCards.slice(0, remainingNewBudget);
  if (introducedNow.length > 0) {
    recordNewCardsIntroduced(today, introducedNow.length);
  }

  return [...reviewDue, ...introducedNow];
}
