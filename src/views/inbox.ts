import { html, nothing, render, TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import {
  DraftBlock,
  applyOps,
  blockHashes,
  findDrafts,
  locateBlock,
  rewriteBlock,
} from "../draft-edits";
import { InboxOp, createBatcher, dropOps, enqueue, opId, pendingOps } from "../inbox-queue";
import { saveInbox } from "../inbox-commit";
import { deckNameFor, loadCachedCards, loadCards } from "../sync";
import { readFile, repoFor, writableRepos } from "../github";
import { loadMarkdown, renderDraftBody } from "../render";
import { prepareMedia } from "../media";
import { typeset } from "../typeset";
import { inRepo } from "../db";
import { parseFile } from "../parser";
import { sliceLines } from "../card-edit-text";
import type { CardSource, EditResult } from "../card-edit";
import { attachSwipe } from "./drill/gestures";
import { createInboxSession, Decision, InboxSession } from "./inbox-session";
import { icon } from "./icons";

/**
 * The Inbox: drafts, one at a time, to keep or throw away (PLAN-1.0 M7).
 *
 * Agents and `hc add --draft` write cards as `Status: draft`; nothing about a
 * draft is scheduled until someone has read it and said yes. This is where
 * that happens, on the review card so it reads like the cards it will become —
 * but with both sides showing, since deciding whether a card is any good is
 * reading it, not recalling it.
 *
 * Swipe right or K keeps (the Status line goes, an ID is stamped if there is
 * none), swipe left or D discards (the block goes), E opens the editor on the
 * block, S skips it until next time, U undoes. Decisions are queued and
 * committed together — when you leave, or after `IDLE_COMMIT_MS` with nothing
 * new decided — as one commit per collection (`inbox-commit.ts`).
 */

/** Long enough that the last decision can still be undone, short enough that a pause saves. */
export const IDLE_COMMIT_MS = 15_000;

/** Drafts in a subscription are someone else's to accept. */
export function writableCollection(repo: string): boolean {
  const config = repoFor(repo);
  return config !== null && !config.readOnly;
}

/** How many drafts are waiting, for Today. Blocks, not cards: a cloze is one draft. */
export function countDrafts(cards: Parameters<typeof findDrafts>[0]): number {
  return findDrafts(cards, writableCollection).length;
}

export async function renderInbox(
  container: HTMLElement,
  onDone: () => void
): Promise<() => void> {
  const drafts = findDrafts(await loadCachedCards(), writableCollection);
  await Promise.all([loadMarkdown(), prepareMedia(drafts.flatMap((d) => d.cards))]);

  const batcher = createBatcher(IDLE_COMMIT_MS, async () => {
    await saveInbox();
    session.committed(new Set((await pendingOps()).map((op) => op.id)));
  });

  const session: InboxSession = createInboxSession(drafts, {
    async enqueue(ops) {
      await enqueue(ops);
      // Read back through the overlay, so Today counts the kept card as new
      // the moment you get back there.
      await loadCards();
      batcher.touch();
    },
    async drop(ids) {
      await dropOps(ids);
      await loadCards();
    },
    newOpId: opId,
    now: () => new Date().toISOString(),
  });

  /** One collection is the common case, and its name on every card would be noise. */
  const showRepo = writableRepos().length > 1;
  const nodes = new Map<string, HTMLElement>();
  let mounted: HTMLElement | null = null;
  let gesturesOn: HTMLElement | null = null;
  let editing = false;
  let leaving = false;

  function cardNode(item: DraftBlock): HTMLElement {
    const key = blockHashes(item).join(",");
    let node = nodes.get(key);
    if (node) return node;
    node = document.createElement("div");
    node.className = "card draft-card";
    const first = item.cards[0];
    const reversed = item.cards.length > 1 && first.content.type === "basic";
    render(
      html`<div class="card-header">
          <span class="card-source">
            <span class="card-deck">${first.deckName}</span>
            <span class="card-path">${showRepo ? `${item.repo} · ${item.path}` : item.path}</span>
          </span>
          <span class="card-tools"></span>
        </div>
        <div class="card-content revealed">${unsafeHTML(renderDraftBody(item.cards))}</div>
        ${first.tags.length > 0 || reversed
          ? html`<div class="draft-meta">
              ${reversed ? html`<span class="pill pill-tint">Both ways</span>` : nothing}
              ${first.tags.map((tag) => html`<span class="pill draft-tag">${tag}</span>`)}
            </div>`
          : nothing}`,
      node
    );
    const built = node;
    void typeset(built.querySelector(".card-content") as HTMLElement).then(() => {
      if (mounted === built) syncScrollLock();
    });
    nodes.set(key, node);
    return node;
  }

  /** As in the drill: a card with nowhere to scroll gives the browser no pan to take. */
  function syncScrollLock(): void {
    const box = mounted?.closest(".card-container");
    const content = mounted?.querySelector(".card-content");
    if (!box || !content) return;
    box.classList.toggle("card-fits", content.scrollHeight <= content.clientHeight);
  }

  function tools(): TemplateResult {
    return html`<button
      class="icon-btn card-edit"
      id="inbox-edit"
      type="button"
      aria-label="Edit draft"
      title="Edit draft"
      @click=${(e: Event) => {
        e.stopPropagation();
        void edit();
      }}
    >
      ${icon("edit", 17)}<span class="icon-btn-label">Edit</span><kbd>E</kbd>
    </button>`;
  }

  function bar(): TemplateResult {
    const position = Math.min(session.done + 1, session.total);
    return html`<header class="drill-bar inbox-bar">
      <button
        id="inbox-back"
        class="icon-btn"
        type="button"
        aria-label="Back to Today"
        title="Back to Today"
        @click=${leave}
      >
        ${icon("back")}<span class="icon-btn-label">Today</span>
      </button>
      <div class="progress">
        <span class="inbox-title">Inbox</span>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${(session.done / Math.max(1, session.total)) * 100}%"></div>
        </div>
        <span class="progress-count">${`${position} / ${session.total}`}</span>
      </div>
      ${undoButton()}
    </header>`;
  }

  function undoButton(): TemplateResult {
    return html`<button
      id="inbox-undo"
      class="icon-btn"
      type="button"
      aria-label="Undo"
      title="Undo"
      ?disabled=${!session.canUndo}
      @click=${() => void session.undo()}
    >
      ${icon("undo", 21)}<span class="icon-btn-label">Undo</span><kbd>U</kbd>
    </button>`;
  }

  function screen(node: HTMLElement): TemplateResult {
    return html`<div class="root drill inbox">
      ${bar()}
      <div class="card-container">
        ${node}
        <div class="swipe-hint" aria-hidden="true" hidden></div>
      </div>
      <div class="controls">
        <div class="inbox-actions">
          <button
            id="discard-btn"
            class="inbox-btn"
            type="button"
            data-action="discard"
            @click=${() => void session.discard()}
          >
            ${icon("trash", 19)}<span>Discard</span><kbd>D</kbd>
          </button>
          <button
            id="skip-btn"
            class="inbox-btn"
            type="button"
            data-action="skip"
            @click=${() => session.skip()}
          >
            <span>Skip</span><kbd>S</kbd>
          </button>
          <button
            id="keep-btn"
            class="inbox-btn"
            type="button"
            data-action="keep"
            @click=${() => void session.keep()}
          >
            ${icon("check", 19)}<span>Keep</span><kbd>K</kbd>
          </button>
        </div>
        <p class="controls-hint" aria-hidden="true">
          <span class="hint-idle">swipe right to keep, left to discard</span
          ><span class="hint-keep">Release to keep</span
          ><span class="hint-discard">Release to discard</span>
        </p>
      </div>
    </div>`;
  }

  function summary(): TemplateResult {
    const counts = session.counts();
    const changed = counts.keep + counts.discard + counts.edit;
    const rows: [Decision, string][] = [
      ["keep", "Kept"],
      ["discard", "Discarded"],
      ["edit", "Edited"],
      ["skip", "Skipped"],
    ];
    const title =
      session.total === 0 ? "Inbox empty" : counts.skip > 0 ? "That's all for now" : "Inbox clear";
    const note =
      session.total === 0
        ? html`Drafts show up here when a card is written with <code>Status: draft</code> — by an agent, or <code>hc add --draft</code>.`
        : changed === 0
        ? "Nothing changed."
        : navigator.onLine
        ? "Saved to GitHub in one commit when you leave."
        : "Saved on this device, and to GitHub once you're back online.";
    return html`<div class="finished inbox-finished">
      <div class="finished-body">
        <span class="done-badge">${icon(session.total === 0 ? "inbox" : "check", 24)}</span>
        <h1>${title}</h1>
        ${session.total > 0
          ? html`<div class="list stats">
              ${rows.map(
                ([decision, label]) => html`<div class="row">
                  <span class="decision-dot" data-decision=${decision}></span>
                  <span class="row-text key">${label}</span>
                  <span class="val">${counts[decision]}</span>
                </div>`
              )}
            </div>`
          : nothing}
        <p class="summary">${note}</p>
        <div class="finished-actions">
          ${session.canUndo
            ? html`<button id="inbox-undo" class="btn btn-lg" type="button" @click=${() => void session.undo()}>
                ${icon("undo", 20)}Undo
              </button>`
            : nothing}
          <button id="inbox-done" class="btn btn-primary btn-lg" type="button" @click=${leave}>Done</button>
        </div>
      </div>
    </div>`;
  }

  function paint(): void {
    if (session.finished) {
      mounted = null;
      gesturesOn = null;
      render(summary(), container);
      return;
    }
    const node = cardNode(session.current!);
    if (node !== mounted) {
      // A node coming back through undo may still carry its swipe's transform.
      node.style.transform = "";
      node.style.transition = "";
      mounted = node;
    }
    render(screen(node), container);
    render(tools(), node.querySelector(".card-tools") as HTMLElement);
    attachGestures();
    syncScrollLock();
  }

  function attachGestures(): void {
    const box = container.querySelector(".card-container") as HTMLElement | null;
    const hint = container.querySelector(".swipe-hint") as HTMLElement | null;
    if (!box || !hint || gesturesOn === box) return;
    attachSwipe(box, hint, {
      enabled: () => !session.finished && !editing,
      action: (right) =>
        right ? { label: "Keep", positive: true } : { label: "Discard", positive: false },
      commit: (right) => void (right ? session.keep() : session.discard()),
    });
    gesturesOn = box;
  }

  /**
   * The card editor, on the block as it will be once the queue is committed:
   * GitHub's file with the queued decisions applied. Saving queues the rewrite
   * like any other decision, so it lands in the same commit; a rewrite that
   * keeps `Status: draft` leaves the draft in front of you to keep or not.
   */
  async function edit(): Promise<void> {
    const item = session.current;
    if (!item || editing || leaving) return;
    editing = true;
    detachKeys();
    try {
      let range: [number, number] = [0, 0];
      const { openCardEditor } = await import("./card-editor");
      const { CardSyntaxError } = await import("../card-edit");
      await openCardEditor(item.cards[0], {
        saveLabel: "Save",
        async load(): Promise<CardSource> {
          const repo = repoFor(item.repo);
          if (!repo) throw new Error(`${item.repo} is no longer one of your collections.`);
          const read = await readFile(repo, item.path);
          const queued = (await pendingOps()).filter(
            (op) => op.repo === item.repo && op.path === item.path
          );
          const { text } = await applyOps(read.text, item.path, queued);
          const at = await locateBlock(text, item.path, blockHashes(item));
          if (!at) throw new Error("This draft has changed on GitHub since it was synced.");
          range = at.range;
          return { file: text, sha: read.sha, text: sliceLines(text, range) };
        },
        async save(source, typed): Promise<EditResult> {
          const replacement = typed;
          const done = (cards: EditResult["cards"]): EditResult => ({
            cards,
            card: cards[0] ?? null,
            migrated: 0,
            keptScheduling: false,
            removedFile: false,
          });
          // Clearing the box deletes a card in the editor everywhere else.
          if (replacement.trim() === "") {
            await session.discard();
            return done([]);
          }
          let parsed;
          try {
            parsed = await parseFile(
              rewriteBlock(source.file, range, replacement),
              item.path,
              deckNameFor(item.path)
            );
          } catch (e) {
            throw new CardSyntaxError(`That isn't a card yet — ${(e as Error).message}`);
          }
          const lines = replacement.replace(/\n+$/, "").split("\n").length;
          const cards = parsed.filter(
            (c) => c.range[0] >= range[0] && c.range[0] < range[0] + lines
          );
          if (cards.length === 0) {
            throw new CardSyntaxError("That isn't a card yet — it needs a Q: and an A:, or a C:.");
          }
          const op: InboxOp = {
            id: opId(),
            repo: item.repo,
            path: item.path,
            action: "edit",
            block: blockHashes(item),
            text: replacement,
            cards,
            at: new Date().toISOString(),
          };
          const next = { repo: item.repo, path: item.path, cards: inRepo(cards, item.repo) };
          await session.edit(op, next);
          return done(next.cards);
        },
      });
    } finally {
      editing = false;
      if (!leaving) attachKeys();
    }
  }

  let keys: AbortController | null = null;
  function attachKeys(): void {
    keys = new AbortController();
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        const key = e.key.toLowerCase();
        if (key === "u") void session.undo();
        if (session.finished) return;
        if (key === "k") void session.keep();
        else if (key === "d") void session.discard();
        else if (key === "s") session.skip();
        else if (key === "e") {
          e.preventDefault();
          void edit();
        } else return;
      },
      { signal: keys.signal }
    );
  }
  function detachKeys(): void {
    keys?.abort();
    keys = null;
  }

  function leave(): void {
    onDone();
  }

  session.onChange(paint);
  attachKeys();
  paint();

  /** Leaving, by any route: commit what was decided, in the background. */
  return () => {
    if (leaving) return;
    leaving = true;
    detachKeys();
    void batcher.now();
  };
}
