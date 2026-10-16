import { DEMO_REPO, enterDemo } from "./demo-mode";
import { repoKey, saveRepos } from "./github";
import { importReviews } from "./db";
import { loadCards, syncCards } from "./sync";
import { cachedCollectionConfig, adoptReviewConfig } from "./collection-settings";
import { refreshStates, replayOptions } from "./review-state";
import { recordSyncSuccess } from "./sync-state";
import { localDay } from "./fsrs";
import { demoHistory } from "./demo-history";
import { Card } from "./types";

/**
 * The starter collection, bundled at build time. The demo's decks are the
 * template repo's (`starter/`), so what a visitor tries is exactly what "Use
 * this template" gives them. Only decks and settings: the README, AGENTS.md
 * and workflow are for the repository, not the app.
 */
const STARTER: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../starter/**/*.{md,toml}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
  ).map(([path, text]) => [path.replace(/^\.\.\/starter\//, ""), text])
);

export function starterFiles(): Record<string, string> {
  return { ...STARTER };
}

/** Cards left new, so the demo's first review is also its tutorial. */
const TUTORIAL = "Welcome.md";
/**
 * One card that keeps being forgotten, so Statistics has a leech to show: the
 * reverse of *la sobremesa*, which has no one English word to give it away.
 */
const STRUGGLING = (card: Card) =>
  card.content.type === "basic" && card.content.answer === "**la sobremesa**";

/**
 * Turn this page into the demo and fill it: settings and database switched to
 * the demo's own (`demo-mode.ts`), the starter decks read in through the same
 * `syncCards` a real collection goes through, and a few weeks of history made
 * up with the real scheduler, so Today and Statistics look lived in.
 *
 * Must run before anything else reads a setting or opens the database.
 */
export async function startDemo(now: Date = new Date()): Promise<void> {
  enterDemo(STARTER);
  saveRepos([DEMO_REPO]);
  const key = repoKey(DEMO_REPO);

  await syncCards(DEMO_REPO);
  adoptReviewConfig((await cachedCollectionConfig(key)).review);

  const cards = await loadCards();
  await importReviews(
    demoHistory(cards, {
      today: localDay(now),
      log: key,
      replay: replayOptions(),
      fresh: (card) => card.filePath === TUTORIAL,
      struggling: STRUGGLING,
    })
  );
  await refreshStates();
  // In step from the start: the demo has no remote to be behind.
  recordSyncSuccess(true, now.toISOString());
  await loadCards();
}
