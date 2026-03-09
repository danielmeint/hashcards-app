import { Card } from "../types";
import { loadCachedCards, syncCards, fullSync } from "../sync";
import { getConfig, getNewCardsPerDay, getNewCardsIntroducedToday } from "../github";
import { getAllPerformances } from "../db";
import { todayStr } from "../fsrs";

type DeckInfo = {
  name: string;
  total: number;
  reviewDue: number;
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

  // Distribute new card budget proportionally across decks
  const deckEntries = [...deckMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalNewAvailable = deckEntries.reduce((s, [, info]) => s + info.newCount, 0);
  const decks: DeckInfo[] = [];

  if (totalNewAvailable <= remainingNewBudget) {
    // Budget exceeds available new cards — no cap needed
    for (const [name, info] of deckEntries) {
      decks.push({ name, total: info.cards.length, reviewDue: info.reviewDue, newCount: info.newCount });
    }
  } else {
    // Distribute proportionally, giving each deck at least 1 if budget allows
    let remaining = deckEntries.map(([name, info]) => ({ name, info, allocated: 0 }));

    // First pass: proportional allocation (floored)
    for (const entry of remaining) {
      const share = Math.floor((entry.info.newCount / totalNewAvailable) * remainingNewBudget);
      entry.allocated = Math.min(share, entry.info.newCount);
    }

    // Second pass: distribute leftover one at a time to decks that still have capacity
    let used = remaining.reduce((s, e) => s + e.allocated, 0);
    for (const entry of remaining) {
      if (used >= remainingNewBudget) break;
      const canAdd = entry.info.newCount - entry.allocated;
      if (canAdd > 0) {
        entry.allocated++;
        used++;
      }
    }

    for (const entry of remaining) {
      decks.push({
        name: entry.name,
        total: entry.info.cards.length,
        reviewDue: entry.info.reviewDue,
        newCount: entry.allocated,
      });
    }
  }

  const totalReviews = decks.reduce((s, d) => s + d.reviewDue, 0);
  const totalNew = decks.reduce((s, d) => s + d.newCount, 0);
  const totalDue = totalReviews + totalNew;

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

  return [...reviewDue, ...newCards.slice(0, remainingNewBudget)];
}
