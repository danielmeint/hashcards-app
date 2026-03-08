import { getConfig } from "./github";
import { syncCards, fullSync, loadCachedCards } from "./sync";
import { renderSettings } from "./views/settings";
import { renderDeckList } from "./views/deck-list";
import { renderDrill } from "./views/drill";
import { Card } from "./types";
import "./style.css";

const app = document.getElementById("app")!;

type View = "settings" | "decks" | "drill";

async function navigate(view: View, drillCards?: Card[]) {
  app.innerHTML = "";

  switch (view) {
    case "settings":
      renderSettings(app, () => navigate("decks"));
      break;

    case "decks":
      await renderDeckList(
        app,
        (cards) => navigate("drill", cards),
        () => navigate("settings")
      );
      break;

    case "drill":
      if (drillCards && drillCards.length > 0) {
        await renderDrill(app, drillCards, () => navigate("decks"));
      } else {
        await navigate("decks");
      }
      break;
  }
}

async function init() {
  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Request persistent storage
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  const config = getConfig();
  if (!config) {
    navigate("settings");
    return;
  }

  // Load cached cards for offline use
  loadCachedCards();

  // Try to sync on startup if online
  if (navigator.onLine) {
    try {
      await syncCards(config);
      await fullSync(config);
    } catch (e) {
      console.warn("Startup sync failed:", e);
    }
  }

  navigate("decks");
}

init();
