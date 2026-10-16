import { html, nothing, render, TemplateResult } from "lit-html";
import { Card, DrillSession, ReviewedPerformance } from "../types";
import { loadCachedCards, loadProblems, syncEverything } from "../sync";
import { DeckProblem } from "../deck-problems";
import { getConfig, getRepos, repoFor, repoKey } from "../github";
import {
  getAllPerformances,
  getReviewsSince,
  loadSession,
  clearSession,
  stateKey,
} from "../db";
import { localDay, todayStr } from "../fsrs";
import {
  getNewCardsPerDay,
  getIntroducedToday,
  refreshIntroduced,
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
import { SyncNotice, syncNotice } from "../sync-notice";
import { pendingOps } from "../inbox-queue";
import { findDrafts } from "../draft-edits";
import { icon } from "./icons";
import { isDemo } from "../demo-mode";
import { now } from "../clock";
import { reviewHistory } from "../review-state";

/**
 * Today: how much is due, one button to review it, and the decks as filters
 * underneath. It replaced a deck list with a Drill button per deck, which put
 * the choice of what to study in front of the one thing you open the app to do.
 */

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
  /** What the day's new-card budget still allows. */
  budgetLeft: number;
  totalReviews: number;
  totalNew: number;
  /** Reviews graded since local midnight, for the caught-up line. */
  reviewedToday: number;
  /** Reviews falling due on each of the next seven days, tomorrow first. */
  comingUp: { date: string; count: number }[];
  lastPushedAt: string | null;
  unsynced: number;
  /** Draft blocks waiting in the Inbox, in collections you can write to. */
  drafts: number;
  /** Inbox decisions not yet committed, and when the oldest was made. */
  pendingEdits: number;
  oldestEditAt: string | null;
  /** What is wrong with the decks' files (`deck-problems.ts`). */
  problems: DeckProblem[];
};

/**
 * Only one deck list exists at a time, so its subscription can live here rather
 * than being threaded through every internal re-render.
 */
let unsubscribe: (() => void) | null = null;

/**
 * Renders Today and returns a teardown. Sync runs behind this view, so counts
 * are painted from cache immediately and refreshed when sync lands.
 */
export async function renderDeckList(
  container: HTMLElement,
  onDrill: (cards: Card[], resume?: DrillSession) => void,
  onSettings: () => void,
  onStats: () => void,
  onInbox: () => void = () => {}
): Promise<() => void> {
  unsubscribe?.();
  unsubscribe = null;

  const keys = new AbortController();
  const dispose = () => {
    unsubscribe?.();
    unsubscribe = null;
    keys.abort();
  };

  let model = await load();
  let status = getSyncStatus();
  const paint = () => render(view(), container);

  async function reload(): Promise<void> {
    model = await load();
    paint();
  }

  /**
   * Quick capture. Today is where it belongs: it is the screen you are on when
   * you are not reviewing, and it already knows every deck by name.
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
    // yet has no business in the bundle Today is waiting on.
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

  function startAll(): void {
    const due = selectDueCards(model.cards, model.performances, model.today);
    if (due.length > 0) onDrill(due);
  }

  function notice(): SyncNotice | null {
    return syncNotice({
      status,
      lastSyncedAt: getLastSyncedAt(),
      lastPushedAt: model.lastPushedAt,
      unsyncedReviews: model.unsynced,
      pendingEdits: model.pendingEdits,
      oldestEditAt: model.oldestEditAt,
      online: navigator.onLine,
    });
  }

  function view(): TemplateResult {
    return model.cards.length === 0 ? empty() : today();
  }

  /**
   * No cached cards. Which of the three reasons applies is the whole message:
   * a first sync in flight is not the same as an unconfigured app, and neither
   * is a sync that failed.
   */
  function empty(): TemplateResult {
    const bar = html`<header class="app-bar">
      <div class="brand">hashcards</div>
      <nav class="app-nav">${settingsButton()}</nav>
    </header>`;

    if (status.phase === "syncing") {
      return html`<div class="page deck-list-view">
        ${bar}
        <div class="empty">
          <h1>Loading your cards…</h1>
          <p>${status.detail ?? "Fetching from GitHub"}</p>
        </div>
      </div>`;
    }
    if (status.phase === "error") {
      return html`<div class="page deck-list-view">
        ${bar}
        <div class="empty">
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
        </div>
      </div>`;
    }
    // A configured repo that synced and turned up nothing is an empty
    // collection, not an unconfigured app — and an empty collection is exactly
    // the one that most needs somewhere to write the first card.
    const configured = getConfig() !== null;
    return html`<div class="page deck-list-view">
      ${bar}
      ${problemsPanel()}
      <div class="empty">
        <h1>${configured ? "No cards yet" : "No cards loaded"}</h1>
        <p>
          ${configured
            ? "Nothing in this repository parses as a deck. Write the first card."
            : "Connect the GitHub repository your cards live in."}
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
      </div>
    </div>`;
  }

  function settingsButton(): TemplateResult {
    return html`<button
      id="settings-btn"
      class="icon-btn"
      aria-label="Settings"
      title="Settings"
      @click=${onSettings}
    >
      ${icon("settings")}<span class="icon-btn-label">Settings</span>
    </button>`;
  }

  function today(): TemplateResult {
    const line = notice();
    const totalDue = model.totalReviews + model.totalNew;

    return html`<div class="page deck-list-view">
      ${appBar(line)}
      ${banner(line)}
      ${problemsPanel()}
      ${model.resumable.length > 0 ? resumeBanner() : nothing}
      ${totalDue > 0 ? dueHero(totalDue) : caughtUp()}
      ${model.drafts > 0 ? inboxRow() : nothing}
      <div class="deck-groups deck-cards">
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
            <section class="group">
              ${group.dir
                ? html`<h2 class="group-title deck-group-name">${group.dir
                    .split("/")
                    .join(" · ")}</h2>`
                : nothing}
              <div class="list">${group.decks.map(deckRow)}</div>
            </section>
          `;
        })}
      </div>
    </div>`;
  }

  /** The dot beside the name: sync at a glance, and a tap to run it. */
  function appBar(line: SyncNotice | null): TemplateResult {
    const syncing = status.phase === "syncing";
    const state = syncing
      ? "syncing"
      : line?.level === "error"
      ? "error"
      : line?.level === "warn"
      ? "warn"
      : !navigator.onLine
      ? "offline"
      : line === null
      ? "never"
      : "ok";
    const label = line ? `${line.text}. Sync now` : "Sync now";
    return html`<header class="app-bar">
      <div class="brand">
        hashcards
        <button
          ?hidden=${isDemo()}
          id="sync-btn"
          class="sync-dot"
          data-state=${state}
          title=${label}
          aria-label=${label}
          ?disabled=${syncing}
          @click=${startSync}
        ></button>
      </div>
      <nav class="app-nav">
        <button
          id="new-card-btn"
          class="icon-btn"
          aria-label="New card"
          title="New card"
          @click=${() => void capture()}
        >
          ${icon("plus")}<span class="icon-btn-label">New card</span>
        </button>
        <button
          id="stats-btn"
          class="icon-btn"
          aria-label="Statistics"
          title="Statistics"
          @click=${onStats}
        >
          ${icon("chart")}<span class="icon-btn-label">Stats</span>
        </button>
        ${settingsButton()}
      </nav>
    </header>`;
  }

  /**
   * Only what needs attention gets a banner: a failure, reviews stuck on the
   * device, or being offline with some owed. "Synced 3 minutes ago" is the
   * dot's tooltip, not a line of text on every visit.
   */
  function banner(line: SyncNotice | null): TemplateResult {
    const shown =
      line !== null && (line.level !== "info" || line.text.startsWith("Offline"));
    return html`<div
      class="notice sync-status ${line?.level === "error"
        ? "notice-error sync-status-error"
        : line?.level === "warn"
        ? "notice-warn sync-status-warn"
        : ""}"
      id="sync-status"
      role="status"
      ?hidden=${!shown}
    >
      <span id="sync-status-text">${line?.text ?? ""}</span>
      <button
        id="sync-action"
        class="link-btn"
        ?hidden=${!line?.action}
        @click=${() => (line?.action === "sign-in" ? onSettings() : startSync())}
      >${line?.action === "sign-in" ? "Sign in" : "Try again"}</button>
    </div>`;
  }

  function dueHero(totalDue: number): TemplateResult {
    const reviews = `${model.totalReviews} review${
      model.totalReviews === 1 ? "" : "s"
    }`;
    return html`<section class="hero">
      <div class="hero-text">
        <p class="hero-date">${dateLabel(now())}</p>
        <p class="hero-count">
          <span class="hero-number">${totalDue}</span>
          <span>${totalDue === 1 ? "card due" : "cards due"}</span>
        </p>
        <p class="hero-sub" id="due-summary">
          ${`${reviews} · ${model.totalNew} new`}
        </p>
      </div>
      <button
        class="btn btn-primary btn-lg drill-all-btn"
        id="drill-all"
        @click=${startAll}
      >
        Start review<kbd>Space</kbd>
      </button>
    </section>`;
  }

  /**
   * Nothing due. Not an empty screen: what was done today, and when the next
   * reviews arrive, so "come back tomorrow" has a number on it.
   */
  function caughtUp(): TemplateResult {
    const done = model.reviewedToday;
    const max = Math.max(1, ...model.comingUp.map((d) => d.count));
    const tomorrow = model.comingUp[0]?.count ?? 0;
    return html`<section class="hero hero-done all-caught-up">
      <p class="hero-date">${dateLabel(now())}</p>
      <div class="caught-up">
        <span class="done-badge">${icon("check", 24)}</span>
        <h1>All caught up</h1>
      </div>
      <p class="hero-sub">
        ${done > 0
          ? `${done} card${done === 1 ? "" : "s"} reviewed today${
              model.introducedToday > 0
                ? `, ${model.introducedToday} of them new`
                : ""
            }.`
          : "Nothing is due today."}
      </p>
      <div class="panel coming-up">
        <div class="panel-head">
          <span>Coming up</span>
          <span>${`${tomorrow} due tomorrow`}</span>
        </div>
        <div class="mini-bars" aria-hidden="true">
          ${model.comingUp.map(
            (d) =>
              html`<span
                style="height: ${(d.count / max) * 100}%"
                title=${`${d.date}: ${d.count}`}
              ></span>`
          )}
        </div>
        <div class="mini-labels" aria-hidden="true">
          ${model.comingUp.map((d) => html`<span>${weekday(d.date)}</span>`)}
        </div>
      </div>
    </section>`;
  }

  /**
   * Drafts waiting for a decision. Only when there are some: an empty Inbox
   * is not something to be reminded of on every visit.
   */
  /**
   * Files that do not parse, and cards written twice. Open when a deck is
   * broken — its newest cards are missing from Today until it is fixed — and
   * folded when it is only duplicates, which cost nothing but tidiness.
   */
  function problemsPanel(): TemplateResult | typeof nothing {
    const problems = model.problems;
    if (problems.length === 0) return nothing;
    const broken = problems.filter((p) => p.kind === "parse").length;
    const summary =
      broken > 0
        ? `${broken === 1 ? "A deck doesn't" : `${broken} decks don't`} parse`
        : `${problems.length === 1 ? "A card is" : `${problems.length} cards are`} in your decks twice`;
    return html`<details class="notice notice-${broken > 0 ? "error" : "warn"} deck-problems" id="deck-problems" ?open=${broken > 0}>
      <summary>${summary}</summary>
      <ul>
        ${problems.map((p) => {
          const where = `${model.repoNames.size > 1 ? `${p.repo}: ` : ""}${p.path}${p.line ? `:${p.line}` : ""}`;
          const url = problemUrl(p);
          return html`<li class="deck-problem" data-kind=${p.kind}>
            <span class="deck-problem-where">${url ? html`<a href=${url} target="_blank" rel="noopener">${where}</a>` : where}</span>
            <span>${p.message}</span>
            ${p.kind === "parse"
              ? html`<span class="deck-problem-note">${p.keptOld
                  ? "Showing the last version of this deck that worked."
                  : "None of its cards can be shown until it is fixed."}</span>`
              : nothing}
          </li>`;
        })}
      </ul>
    </details>`;
  }

  function inboxRow(): TemplateResult {
    const n = model.drafts;
    return html`<div class="list inbox-entry">
      <button id="inbox-btn" class="row inbox-row" @click=${onInbox}>
        <span class="row-icon">${icon("inbox", 20)}</span>
        <span class="row-text">
          <span class="row-title">Inbox</span>
          <span class="row-sub">Drafts to keep or discard</span>
        </span>
        <span class="pill pill-new" id="inbox-count">${`${n} draft${n === 1 ? "" : "s"}`}</span>
        ${icon("chevron", 18)}
      </button>
    </div>`;
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
          id="discard-btn"
          class="btn btn-small"
          @click=${async () => {
            await clearSession();
            await reload();
          }}
        >
          Discard
        </button>
        <button
          id="resume-btn"
          class="btn btn-primary btn-small"
          @click=${() => {
            // Completed cards travel too: undo needs to resolve any card in
            // the session.
            const session = model.session!;
            const keys = new Set([...session.queue, ...session.completed]);
            onDrill(
              model.cards.filter((c) => keys.has(stateKey(c))),
              session
            );
          }}
        >
          Resume
        </button>
      </div>
    </div>`;
  }

  /**
   * A whole row is the target. What it promises is the deck's own supply: a
   * deck with new cards but no budget left today says so rather than offering
   * a review that would come up empty.
   */
  function deckRow(deck: DeckInfo): TemplateResult {
    const newToday = Math.min(deck.newCount, model.budgetLeft);
    const drillable = deck.reviewDue + newToday > 0;
    const status =
      deck.reviewDue > 0
        ? html`<span class="pill pill-due">${`${deck.reviewDue} due`}</span>`
        : newToday > 0
        ? html`<span class="pill pill-new">${`${deck.newCount} new`}</span>`
        : deck.newCount > 0
        ? html`<span class="row-status">${`${deck.newCount} new left`}</span>`
        : html`<span class="row-status">${icon("check", 14)}Done</span>`;
    const text = html`<span class="row-text">
      <span class="row-title deck-name">${deck.name}</span>
      <span class="row-sub deck-counts">${`${deck.total} card${
        deck.total === 1 ? "" : "s"
      }`}</span>
    </span>`;

    if (!drillable) {
      return html`<div class="row deck-row" data-path=${deck.path}>
        ${text}${status}
      </div>`;
    }
    return html`<button
      class="row deck-row"
      data-path=${deck.path}
      @click=${() => {
        const deckCards = model.cards.filter((c) => c.filePath === deck.path);
        const due = selectDueCards(deckCards, model.performances, model.today);
        if (due.length > 0) onDrill(due);
      }}
    >
      ${text}${status}${icon("chevron", 18)}
    </button>`;
  }

  paint();

  // Space starts the review, as it reveals inside one — unless focus is on
  // something Space already means something to.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== " " || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
      if (document.querySelector(".editor-backdrop")) return;
      if (!container.querySelector("#drill-all")) return;
      e.preventDefault();
      startAll();
    },
    { signal: keys.signal }
  );

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

/** "Thursday, 15 October". */
function dateLabel(date: Date): string {
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return `${weekday}, ${day}`;
}

function weekday(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short",
  });
}

function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDay(d);
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
  const queued = await pendingOps();
  const pending = {
    pendingEdits: queued.length,
    oldestEditAt: queued[0]?.at ?? null,
  };

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
      budgetLeft: remainingBudget(today),
      totalReviews: 0,
      totalNew: 0,
      reviewedToday: 0,
      comingUp: [],
      lastPushedAt,
      unsynced,
      drafts: 0,
      ...pending,
      problems: await loadProblems(),
    };
  }

  const performances = await getAllPerformances();

  // An interrupted drill is offered back rather than resumed automatically —
  // reopening the app is not always an intent to carry on where you left off.
  const session = await loadSession();
  const byKey = new Map(cards.map((c) => [stateKey(c), c]));
  const resumable = session
    ? session.queue.filter((key) => byKey.has(key))
    : [];
  // A session whose cards have all left the repo can never be resumed.
  if (session && resumable.length === 0) await clearSession();

  // One deck per source file, keyed by collection and path — two collections
  // can each hold an `Algebra.md`, and they are not the same deck.
  const byFile = new Map<string, Card[]>();
  for (const card of cards) {
    // A draft is the Inbox's, not a deck's: not a card yet, so not counted in
    // one — and a file of nothing but drafts is no deck yet at all.
    if (card.status === "draft") continue;
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

  // On any device, as the budget and Statistics count.
  const reviewedToday = new Set(
    (await reviewHistory()).filter((h) => h.day === today).map((h) => h.key)
  ).size;

  const comingUp = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i + 1);
    let count = 0;
    for (const perf of performances.values()) if (perf.dueDate === date) count++;
    return { date, count };
  });

  // Cards started today on any device, from the log just loaded.
  await refreshIntroduced(today);
  const budgetLeft = remainingBudget(today);
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
    budgetLeft,
    totalReviews: decks.reduce((s, d) => s + d.reviewDue, 0),
    // Clamped once, across every deck: the budget is one pool, and the screen
    // has to promise what pressing Start will actually give you.
    totalNew: Math.min(
      decks.reduce((s, d) => s + d.newCount, 0),
      budgetLeft
    ),
    reviewedToday,
    comingUp,
    lastPushedAt,
    unsynced,
    drafts: findDrafts(cards, (repo) => {
      const config = getRepos().find((r) => repoKey(r) === repo);
      return config !== undefined && !config.readOnly;
    }).length,
    ...pending,
    problems: await loadProblems(),
  };
}

/** The problem's line on GitHub, where the file can be fixed; null in the demo. */
function problemUrl(p: DeckProblem): string | null {
  const repo = repoFor(p.repo);
  if (!repo || isDemo()) return null;
  const path = p.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${path}${p.line ? `#L${p.line}` : ""}`;
}
