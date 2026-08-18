import { getConfig } from "./github";
import { syncAll, loadCachedCards } from "./sync";
import { renderSettings } from "./views/settings";
import { renderDeckList } from "./views/deck-list";
import { renderDrill } from "./views/drill";
import { renderStats } from "./views/stats";
import { getDemoData } from "./demo";
import { applyTheme, watchSystemTheme } from "./theme";
import { Card, DrillSession } from "./types";
import "./style.css";

const app = document.getElementById("app")!;

type View = "settings" | "decks" | "drill" | "stats";

/**
 * Views that outlive their own render — the deck list listens for background
 * sync — hand back a teardown, so a sync landing after the user has moved on
 * cannot repaint a screen they have left.
 */
let disposeView: (() => void) | null = null;

async function navigate(
  view: View,
  drillCards?: Card[],
  resume?: DrillSession
) {
  disposeView?.();
  disposeView = null;
  app.innerHTML = "";

  switch (view) {
    case "settings":
      renderSettings(app, () => navigate("decks"));
      break;

    case "decks":
      disposeView = await renderDeckList(
        app,
        (cards, session) => navigate("drill", cards, session),
        () => navigate("settings"),
        () => navigate("stats")
      );
      break;

    case "drill":
      if (drillCards && drillCards.length > 0) {
        await renderDrill(app, drillCards, () => navigate("decks"), { resume });
      } else {
        await navigate("decks");
      }
      break;

    case "stats":
      await renderStats(app, () => navigate("decks"));
      break;
  }
}

async function init() {
  // Before any render, so the first paint is already in the right theme.
  applyTheme();
  watchSystemTheme();

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Request persistent storage
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Demo mode: #demo launches a drill with fake cards, no persistence
  if (window.location.hash === "#demo") {
    const demo = await getDemoData();
    await renderDrill(app, demo.cards, () => navigate("decks"), {
      dryRun: true,
      cache: demo.cache,
    });
    return;
  }

  const config = getConfig();
  if (!config) {
    navigate("settings");
    return;
  }

  // Paint from cache first, then sync behind the UI. A cold open used to wait
  // on a tree call, N content calls and a state read before showing anything;
  // now the deck list is on screen immediately and updates when sync lands.
  loadCachedCards();
  await navigate("decks");

  // Started after the first render, so the deck list is already subscribed and
  // sees every progress update.
  if (navigator.onLine) syncAll(config);
}

init();
