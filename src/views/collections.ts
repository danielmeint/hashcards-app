import { html, render, TemplateResult } from "lit-html";
import {
  RepoConfig,
  getRepos,
  repoKey,
  saveRepos,
} from "../github";
import { forgetRepo, setMeta } from "../db";
import { loadCards, syncEverything } from "../sync";

/**
 * Which collections the app reads.
 *
 * The first writable one is yours — the repository sign-in picked, managed in
 * the panel above this. Everything else here is a **subscription**: someone
 * else's deck repository, read for its cards and never committed to. That is
 * the version of this app with a network effect, and it needs no new protocol
 * for it: a public deck is an ordinary GitHub repo, forkable and
 * pull-requestable, which is not something any other SRS tool can say.
 *
 * Your review state for a subscribed card stays on this device and in your own
 * repository's state file. It is yours, and a repo you do not own is not a
 * place to put it.
 */

type Draft = { owner: string; repo: string; branch: string };

const EMPTY: Draft = { owner: "", repo: "", branch: "main" };

export function renderCollections(host: HTMLElement, onChanged: () => void): void {
  let repos = getRepos();
  let draft: Draft = { ...EMPTY };
  let adding = false;
  let error: string | null = null;

  const paint = () => render(view(), host);

  function commit(next: RepoConfig[]): void {
    saveRepos(next);
    repos = getRepos();
    onChanged();
    paint();
  }

  async function remove(repo: RepoConfig): Promise<void> {
    const key = repoKey(repo);
    commit(repos.filter((r) => repoKey(r) !== key));
    // The cards go with it, or the deck list keeps showing a collection that
    // is no longer configured. Scheduling stays: it is a record of reviews
    // that happened, and re-adding the repo should not start them over.
    await forgetRepo(key);
    await setMeta(`tree_etag:${key}`, undefined);
    await loadCards();
    onChanged();
  }

  function add(): void {
    const owner = draft.owner.trim();
    const repo = draft.repo.trim();
    if (!owner || !repo) {
      error = "Both an owner and a repository name are needed.";
      paint();
      return;
    }
    const key = `${owner}/${repo}`;
    if (repos.some((r) => repoKey(r) === key)) {
      error = `${key} is already in the list.`;
      paint();
      return;
    }
    const branch = draft.branch.trim() || "main";
    error = null;
    adding = false;
    draft = { ...EMPTY };
    commit([...repos, { owner, repo, branch, readOnly: true }]);
    // Fetch its cards now rather than at the next cold open — adding a deck and
    // seeing nothing happen is indistinguishable from it not having worked.
    void syncEverything();
  }

  function row(repo: RepoConfig): TemplateResult {
    const key = repoKey(repo);
    return html`<div class="collection-row" data-repo=${key}>
      <div class="collection-name">
        <span class="collection-key">${key}</span>
        <span class="collection-tag"
          >${repo.readOnly ? "subscribed" : "yours"}${repo.branch === "main"
            ? ""
            : ` · ${repo.branch}`}</span
        >
      </div>
      <button
        type="button"
        class="btn btn-small collection-remove"
        @click=${() => void remove(repo)}
      >
        Remove
      </button>
    </div>`;
  }

  function form(): TemplateResult {
    return html`<div class="collection-add">
      <input
        type="text"
        class="collection-owner"
        placeholder="owner"
        aria-label="Owner"
        .value=${draft.owner}
        @input=${(e: Event) => {
          draft = { ...draft, owner: (e.target as HTMLInputElement).value };
        }}
      />
      <input
        type="text"
        class="collection-repo"
        placeholder="repository"
        aria-label="Repository"
        .value=${draft.repo}
        @input=${(e: Event) => {
          draft = { ...draft, repo: (e.target as HTMLInputElement).value };
        }}
      />
      <input
        type="text"
        class="collection-branch"
        placeholder="main"
        aria-label="Branch"
        .value=${draft.branch}
        @input=${(e: Event) => {
          draft = { ...draft, branch: (e.target as HTMLInputElement).value };
        }}
      />
      <button type="button" class="btn collection-save" @click=${add}>
        Subscribe
      </button>
    </div>`;
  }

  function view(): TemplateResult {
    return html`
      ${repos.length === 0
        ? html`<p class="collection-empty">No collections yet.</p>`
        : repos.map(row)}
      <p class="collection-error" ?hidden=${error === null}>${error ?? ""}</p>
      ${adding
        ? form()
        : html`<button
            type="button"
            class="btn collection-add-btn"
            @click=${() => {
              adding = true;
              error = null;
              paint();
            }}
          >
            Subscribe to a deck
          </button>`}
      <p class="collection-note">
        A subscription is read-only: its cards are drilled here and your
        scheduling stays with you, but nothing is ever written back to it.
      </p>
    `;
  }

  paint();
}
