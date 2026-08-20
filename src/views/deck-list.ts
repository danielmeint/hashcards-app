import { html, nothing, render, TemplateResult } from "lit-html";
import { Card, DrillSession, ReviewedPerformance } from "../types";
import { loadCachedCards, syncEverything } from "../sync";
import { getConfig, getRepos, repoKey } from "../github";
import {
  getAllPerformances,
  getReviewsSince,
  loadSession,
  clearSession,
} from "../db";
import { todayStr } from "../fsrs";
import {
  getNewCardsPerDay,
  getIntroducedToday,
  selectDueCards,
  countDue,
  remainingBudget,
} from "../new-card-budget";
import {
  getLastPushedAt,
  getLastSyncedAt,
  getSyncStatus,
  onSyncStatus,
} from "../sync-state";
import { syncNotice } from "../sync-notice";

type DeckInfo = {
  /** `owner/repo` — which collection this deck belongs to. */
  repo: string;
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

/**
 * One heading's worth of decks. A collection and a directory within it, since
 * `Algebra.md` in your repo and `Algebra.md` in a deck you subscribe to are two
 * different decks that would otherwise sit under the same nameless heading.
 */
type DeckGroup = { repo: string; dir: string; decks: DeckInfo[] };

/** Everything on screen that comes from storage rather than from sync status. */
type Model = {
  cards: Card[];
  performances: Map<string, ReviewedPerformance>;
  today: string;
  session: DrillSession | null;
  resumable: string[];
  groups: DeckGroup[];
  /** Collection key → whether it is a subscription, for the headings. */
  repoNames: Map<string, boolean>;
  newPerDay: number;
  introducedToday: number;
  totalReviews: number;
  totalNew: number;
  lastPushedAt: string | null;
  unsynced: number;
};

/**
 * Only one deck list exists at a time, so its subscription can live here rather
 * than being threaded through every internal re-render.
 */
let unsubscribe: (() => void) | null = null;

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

  let model = await load();
  let status = getSyncStatus();
  const paint = () => render(view(), container);

  async function reload(): Promise<void> {
    model = await load();
    paint();
  }

  /**
   * Quick capture. The deck list is where it belongs: it is the screen you are
   * on when you are not drilling, and it already knows every deck by name.
   */
  async function capture(): Promise<void> {
    const config = getConfig();
    if (!config || config.readOnly) {
      onSettings();
      return;
    }
    // Only decks in the collection the card will be written to. Offering a
    // subscription's deck would be offering to commit to someone else's repo.
    const decks = model.groups
      .filter((group) => group.repo === repoKey(config))
      .flatMap((group) =>
        group.decks.map((deck) => ({
          path: deck.path,
          // Two decks can share a name, so the one in a folder says which.
          name: deck.dir ? `${deck.dir}/${deck.name}` : deck.name,
        }))
      );
    // Loaded on the click rather than at startup: a sheet nobody has opened
    // yet has no business in the bundle the deck list is waiting on.
    const { openCapture } = await import("./capture");
    if (await openCapture(config, decks)) await reload();
  }

  const startSync = () => {
    if (getRepos().length === 0) {
      onSettings();
      return;
    }
    // Fire and forget: progress and failure both arrive through the status.
    syncEverything();
  };

  function notice() {
    return syncNotice({
      status,
      lastSyncedAt: getLastSyncedAt(),
      lastPushedAt: model.lastPushedAt,
      unsyncedReviews: model.unsynced,
      online: navigator.onLine,
    });
  }

  function view(): TemplateResult {
    return model.cards.length === 0 ? empty() : decks();
  }

  /**
   * No cached cards. Which of the three reasons applies is the whole message:
   * a first sync in flight is not the same as an unconfigured app, and neither
   * is a sync that failed.
   */
  function empty(): TemplateResult {
    if (status.phase === "syncing") {
      return html`<div class="deck-list-view deck-list-empty">
        <h1>Loading your cards…</h1>
        <p>${status.detail ?? "Fetching from GitHub"}</p>
      </div>`;
    }
    if (status.phase === "error") {
      return html`<div class="deck-list-view deck-list-empty">
        <h1>
          ${status.needsSignIn
            ? "Signed out of GitHub"
            : "Couldn't load your cards"}
        </h1>
        <p class="sync-status-error">${status.message}</p>
        <div class="empty-actions">
          ${status.needsSignIn
            ? html`<button
                id="goto-settings"
                class="btn btn-primary"
                @click=${onSettings}
              >
                Sign in
              </button>`
            : html`<button
                  id="retry-btn"
                  class="btn btn-primary"
                  @click=${startSync}
                >
                  Try again
                </button>
                <button id="goto-settings" class="btn" @click=${onSettings}>
                  Settings
                </button>`}
        </div>
      </div>`;
    }
    // A configured repo that synced and turned up nothing is an empty
    // collection, not an unconfigured app — and an empty collection is exactly
    // the one that most needs somewhere to write the first card.
    const configured = getConfig() !== null;
    return html`<div class="deck-list-view deck-list-empty">
      <h1>${configured ? "No cards yet" : "No cards loaded"}</h1>
      <p>
        ${configured
          ? "Nothing in this repository parses as a deck. Write the first card."
          : "Configure your GitHub repo and sync first."}
      </p>
      <div class="empty-actions">
        ${configured
          ? html`<button
              id="new-card-btn"
              class="btn btn-primary"
              @click=${() => void capture()}
            >
              New card
            </button>`
          : nothing}
        <button id="goto-settings" class="btn" @click=${onSettings}>
          Settings
        </button>
      </div>
    </div>`;
  }

  function decks(): TemplateResult {
    const line = notice();
    const syncing = status.phase === "syncing";
    const totalDue = model.totalReviews + model.totalNew;

    return html`<div class="deck-list-view">
      <div class="deck-list-header">
        <h1>Decks</h1>
        <div class="deck-list-actions">
          <button
            id="new-card-btn"
            class="btn"
            title="New card"
            @click=${() => void capture()}
          >
            + Card
          </button>
          <button id="stats-btn" class="btn" title="Statistics" @click=${onStats}>
            Stats
          </button>
          <button
            id="sync-btn"
            class="btn"
            title="Sync"
            ?disabled=${syncing}
            @click=${startSync}
          >${syncing ? "…" : "⟳"}</button>
          <button
            id="settings-btn"
            class="btn"
            title="Settings"
            @click=${onSettings}
          >⚙</button>
        </div>
      </div>
      <div class="new-budget-status">
        ${`New today: ${model.introducedToday}/${model.newPerDay}`}
      </div>
      <div
        class="sync-status ${line?.level === "error"
          ? "sync-status-error"
          : line?.level === "warn"
          ? "sync-status-warn"
          : ""}"
        id="sync-status"
        ?hidden=${line === null}
      >
        <span id="sync-status-text">${line?.text ?? ""}</span>
        <button
          id="sync-action"
          class="btn btn-small"
          ?hidden=${!line?.action}
          @click=${() => (line?.action === "sign-in" ? onSettings() : startSync())}
        >${line?.action === "sign-in" ? "Sign in" : "Try again"}</button>
      </div>
      ${model.resumable.length > 0 ? resumeBanner() : nothing}
      ${totalDue > 0
        ? html`<button
            class="btn btn-primary drill-all-btn"
            id="drill-all"
            @click=${() => {
              const due = selectDueCards(model.cards, model.performances, model.today);
              if (due.length > 0) onDrill(due);
            }}
          >${drillAllLabel()}</button>`
        : html`<div class="all-caught-up">All caught up!</div>`}
      <div class="deck-cards">
        ${model.groups.map((group, i) => {
          // The collection's name only when it changes, and only when there is
          // more than one — a single-repo app should not grow a heading.
          const newRepo =
            model.repoNames.size > 1 &&
            (i === 0 || model.groups[i - 1].repo !== group.repo);
          return html`
            ${newRepo
              ? html`<div class="deck-repo-name">
                  ${group.repo}
                  ${model.repoNames.get(group.repo)
                    ? html`<span class="deck-repo-tag">subscribed</span>`
                    : nothing}
                </div>`
              : nothing}
            ${group.dir
              ? html`<div class="deck-group-name">${group.dir}</div>`
              : nothing}
            ${group.decks.map(deckRow)}
          `;
        })}
      </div>
    </div>`;
  }

  function drillAllLabel(): string {
    const reviews = `${model.totalReviews} review${
      model.totalReviews === 1 ? "" : "s"
    }`;
    return `Drill All (${reviews}, ${model.totalNew} new)`;
  }

  function resumeBanner(): TemplateResult {
    const left = model.resumable.length;
    return html`<div class="resume-banner">
      <div class="resume-text">
        <strong>Session in progress</strong>
        <span>${`${left} card${left === 1 ? "" : "s"} left`}</span>
      </div>
      <div class="resume-actions">
        <button
          id="resume-btn"
          class="btn btn-primary"
          @click=${() => {
            // Completed cards travel too: undo needs to resolve any card in
            // the session.
            const session = model.session!;
            const hashes = new Set([...session.queue, ...session.completed]);
            onDrill(
              model.cards.filter((c) => hashes.has(c.hash)),
              session
            );
          }}
        >
          Resume
        </button>
        <button
          id="discard-btn"
          class="btn"
          @click=${async () => {
            await clearSession();
            await reload();
          }}
        >
          Discard
        </button>
      </div>
    </div>`;
  }

  function deckRow(deck: DeckInfo): TemplateResult {
    const counts = `${deck.total} cards · ${deck.reviewDue} review${
      deck.reviewDue === 1 ? "" : "s"
    } · ${deck.newCount} new`;
    return html`<div class="deck-card" data-path=${deck.path}>
      <div class="deck-info">
        <span class="deck-name">${deck.name}</span>
        <span class="deck-counts">${counts}</span>
      </div>
      ${deck.reviewDue + deck.newCount > 0
        ? html`<button
            class="btn deck-drill-btn"
            @click=${() => {
              const deckCards = model.cards.filter(
                (c) => c.filePath === deck.path
              );
              const due = selectDueCards(deckCards, model.performances, model.today);
              if (due.length > 0) onDrill(due);
            }}
          >
            Drill
          </button>`
        : nothing}
    </div>`;
  }

  paint();

  // A progress tick moves only the status line, and repainting the whole view
  // for one is what lit-html is for. Anything else can have changed the counts,
  // so those are re-read from storage first — which is the only part that costs
  // anything.
  unsubscribe = onSyncStatus((next) => {
    status = next;
    if (next.phase === "syncing") paint();
    else void reload();
  });

  return dispose;
}

/**
 * Reviews that have not left the device.
 *
 * Taken from the review log rather than from a flag the app has to remember to
 * set: reviews recorded after the last confirmed push are exactly the ones
 * still owed, and a crash mid-drill cannot lose track of that the way a flag
 * can. No push has ever landed means every review is owed.
 */
async function load(): Promise<Model> {
  const cards = await loadCachedCards();
  const today = todayStr();
  const lastPushedAt = getLastPushedAt();
  const unsynced = (await getReviewsSince(lastPushedAt ?? "")).length;

  if (cards.length === 0) {
    return {
      cards,
      performances: new Map(),
      today,
      session: null,
      resumable: [],
      groups: [],
      repoNames: new Map(),
      newPerDay: getNewCardsPerDay(),
      introducedToday: 0,
      totalReviews: 0,
      totalNew: 0,
      lastPushedAt,
      unsynced,
    };
  }

  const performances = await getAllPerformances();

  // An interrupted drill is offered back rather than resumed automatically —
  // reopening the app is not always an intent to carry on where you left off.
  const session = await loadSession();
  const byHash = new Map(cards.map((c) => [c.hash, c]));
  const resumable = session
    ? session.queue.filter((hash) => byHash.has(hash))
    : [];
  // A session whose cards have all left the repo can never be resumed.
  if (session && resumable.length === 0) await clearSession();

  // One deck per source file, keyed by collection and path — two collections
  // can each hold an `Algebra.md`, and they are not the same deck.
  const byFile = new Map<string, Card[]>();
  for (const card of cards) {
    const key = `${card.repo}\u0000${card.filePath}`;
    const deckCards = byFile.get(key);
    if (deckCards) deckCards.push(card);
    else byFile.set(key, [card]);
  }

  const decks: DeckInfo[] = [];
  for (const [key, deckCards] of byFile) {
    const counts = countDue(deckCards, performances, today);
    const [repo, path] = key.split("\u0000");
    decks.push({
      repo,
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

  // Grouped by collection and then by directory, root first, so the list reads
  // the way the repository looks — and so two decks with the same name are told
  // apart by where they live.
  const groups: DeckGroup[] = [];
  for (const deck of decks) {
    const group = groups.find(
      (g) => g.repo === deck.repo && g.dir === deck.dir
    );
    if (group) group.decks.push(deck);
    else groups.push({ repo: deck.repo, dir: deck.dir, decks: [deck] });
  }
  // Collections in configured order — yours first, then what you subscribe to.
  const order = getRepos().map(repoKey);
  groups.sort(
    (a, b) =>
      order.indexOf(a.repo) - order.indexOf(b.repo) ||
      (a.dir === "" ? -1 : b.dir === "" ? 1 : a.dir.localeCompare(b.dir))
  );

  return {
    cards,
    performances,
    today,
    session,
    resumable,
    groups,
    repoNames: new Map(getRepos().map((r) => [repoKey(r), r.readOnly === true])),
    newPerDay: getNewCardsPerDay(),
    introducedToday: getIntroducedToday(today),
    totalReviews: decks.reduce((s, d) => s + d.reviewDue, 0),
    // Clamped once, across every deck: the budget is one pool, and the button
    // has to promise what pressing it will actually give you.
    totalNew: Math.min(
      decks.reduce((s, d) => s + d.newCount, 0),
      remainingBudget(today)
    ),
    lastPushedAt,
    unsynced,
  };
}
