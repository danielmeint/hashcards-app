import { getRepos } from "./github";
import { completeSignIn } from "./auth";
import { syncEverything, loadCachedCards } from "./sync";
import { startAutoSync } from "./auto-sync";
import { adoptLegacySyncTimestamp } from "./sync-state";
import { renderSettings } from "./views/settings";
import { renderDeckList } from "./views/deck-list";
import { renderDrill } from "./views/drill";
import { renderStats } from "./views/stats";
import { renderInbox } from "./views/inbox";
import { pushSettings } from "./sync";
import { renderWelcome } from "./views/welcome";
import { isDemo } from "./demo-mode";
import { warmTypesetting } from "./typeset";
import { applyTheme, watchSystemTheme } from "./theme";
import { Card, DrillSession } from "./types";
import { html, render } from "lit-html";
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

type View = "welcome" | "settings" | "decks" | "drill" | "stats" | "inbox";

/** Where Settings goes back to: Today once there is a collection, the welcome before. */
const home = (): View => (getRepos().length === 0 ? "welcome" : "decks");

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
    case "welcome":
      await renderWelcome(host, () => navigate("settings"));
      break;

    case "settings":
      // Leaving Settings is when its collection settings go to the repo,
      // rather than whenever the next sync happens to run: another device
      // opened now should already see them.
      disposeView = () => void pushSettings();
      await renderSettings(host, () => navigate(home()), settingsNotice);
      settingsNotice = undefined;
      break;

    case "decks":
      disposeView = await renderDeckList(
        host,
        (cards, session) => navigate("drill", cards, session),
        () => navigate("settings"),
        () => navigate("stats"),
        () => navigate("inbox")
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

    case "inbox":
      disposeView = await renderInbox(host, () => navigate("decks"));
      break;
  }
}

async function init() {
  // The demo and the real app cannot share a page: the demo swaps out storage
  // before anything reads it (`demo-mode.ts`). So crossing between them, by
  // the welcome's button or by editing the URL, is a reload.
  window.addEventListener("hashchange", () => {
    if ((location.hash === "#demo") !== isDemo()) location.reload();
  });
  if (location.hash === "#demo") {
    await startDemoSession();
    return;
  }

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

  // Before anything reads the credential: this page load may be the return leg
  // of a sign-in, and the one-time code in the URL has to be redeemed and
  // cleared exactly once.
  let justSignedIn = false;
  try {
    justSignedIn = await completeSignIn();
  } catch (e) {
    settingsNotice = (e as Error).message;
  }

  // No collection yet: the welcome, with its three ways in. Except straight
  // back from signing in, where choosing the repository is the obvious next
  // step and Settings is where the picker is, or after a failed sign-in, whose
  // message Settings shows.
  if (getRepos().length === 0) {
    await navigate(justSignedIn || settingsNotice ? "settings" : "welcome");
    return;
  }
  if (settingsNotice) {
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

/**
 * `#demo`: the whole app on the starter decks, nothing saved. Loaded on demand,
 * so the starter decks bundled into it cost the real app nothing.
 */
async function startDemoSession(): Promise<void> {
  const { startDemo } = await import("./demo");
  await startDemo();
  applyTheme();
  watchSystemTheme();
  document.documentElement.classList.add("demo");
  const bar = document.createElement("div");
  bar.className = "demo-bar";
  bar.setAttribute("role", "note");
  // A plain link to `/`: leaving the fragment off is a full navigation, which
  // is what leaving the demo has to be.
  render(
    html`<span><strong>Demo</strong><span class="demo-bar-detail"> · nothing is saved</span></span>
      <a href="/" id="demo-exit">Start your own collection</a>`,
    bar
  );
  app.before(bar);
  await navigate("decks");
}

init();
