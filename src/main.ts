import { getRepos } from "./github";
import { completeSignIn } from "./auth";
import { syncEverything, loadCachedCards } from "./sync";
import { startAutoSync } from "./auto-sync";
import { adoptLegacySyncTimestamp } from "./sync-state";
import { renderSettings } from "./views/settings";
import { renderDeckList } from "./views/deck-list";
import { renderDrill } from "./views/drill";
import { renderStats } from "./views/stats";
import { getDemoData } from "./demo";
import { warmTypesetting } from "./typeset";
import { applyTheme, watchSystemTheme } from "./theme";
import { Card, DrillSession } from "./types";
import "./style.css";

const app = document.getElementById("app")!;

/**
 * An empty element for a view to render into, replacing whatever was there.
 *
 * A fresh element each time rather than emptying the old one: lit-html keeps
 * its render state on the container it was handed, and a container something
 * else has emptied leaves it updating nodes that are no longer in the document
 * — silently, since nothing throws.
 */
function freshHost(): HTMLElement {
  app.replaceChildren();
  const host = document.createElement("div");
  app.append(host);
  return host;
}

type View = "settings" | "decks" | "drill" | "stats";

/**
 * Views that outlive their own render — the deck list listens for background
 * sync — hand back a teardown, so a sync landing after the user has moved on
 * cannot repaint a screen they have left.
 */
let disposeView: (() => void) | null = null;

/** Message for the next Settings render — a failed sign-in, mostly. */
let settingsNotice: string | undefined;

async function navigate(
  view: View,
  drillCards?: Card[],
  resume?: DrillSession
) {
  disposeView?.();
  disposeView = null;

  const host = freshHost();

  switch (view) {
    case "settings":
      await renderSettings(host, () => navigate("decks"), settingsNotice);
      settingsNotice = undefined;
      break;

    case "decks":
      disposeView = await renderDeckList(
        host,
        (cards, session) => navigate("drill", cards, session),
        () => navigate("settings"),
        () => navigate("stats")
      );
      break;

    case "drill":
      if (drillCards && drillCards.length > 0) {
        await renderDrill(host, drillCards, () => navigate("decks"), { resume });
      } else {
        await navigate("decks");
      }
      break;

    case "stats":
      await renderStats(host, () => navigate("decks"));
      break;
  }
}

async function init() {
  // Before any sync of this session can record a timestamp of its own.
  adoptLegacySyncTimestamp();

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

  // Before anything reads the credential, and before the demo check: this page
  // load may be the return leg of a sign-in, and the one-time code in the URL
  // has to be redeemed and cleared exactly once.
  try {
    await completeSignIn();
  } catch (e) {
    settingsNotice = (e as Error).message;
  }

  // Demo mode: #demo launches a drill with fake cards, no persistence
  if (window.location.hash === "#demo") {
    const demo = await getDemoData();
    await renderDrill(freshHost(), demo.cards, () => navigate("decks"), {
      dryRun: true,
      cache: demo.cache,
    });
    return;
  }

  // Settings is both the first-run screen and where a sign-in that just landed
  // without a repository picks one. Everything else opens on the deck list,
  // including a sign-in that had a repository waiting for it.
  if (getRepos().length === 0 || settingsNotice) {
    await navigate("settings");
    return;
  }

  // Paint from cache first, then sync behind the UI. A cold open used to wait
  // on a tree call, N content calls and a state read before showing anything;
  // now the deck list is on screen immediately and updates when sync lands.
  const cards = await loadCachedCards();
  await navigate("decks");

  // Only now, and only if the collection has any: a typesetter fetched during
  // idle time is one the first card with maths in it does not have to wait for,
  // and one that is in the cache before the network goes away.
  warmTypesetting(cards);

  // Started after the first render, so the deck list is already subscribed and
  // sees every progress update.
  if (navigator.onLine) syncEverything();

  // And keeps trying afterwards: reconnecting or returning to the tab retries
  // a sync that never landed, rather than leaving it until the next cold open.
  startAutoSync();
}

init();
