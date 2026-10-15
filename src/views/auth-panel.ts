import { html, nothing, render, TemplateResult } from "lit-html";
import {
  GitHubConfig,
  RepoRef,
  getConfig,
  inspectConnection,
  listAccessibleRepos,
  saveConfig,
} from "../github";
import {
  beginSignIn,
  loadCredential,
  saveCredential,
  signOut,
} from "../auth";
import { installUrl, signInAvailable } from "../github-app";
import { formatSyncAge, getLastSyncedAt } from "../sync-state";
import { icon } from "./icons";

/**
 * The connection half of Settings: how the app authenticates, and which
 * repository it reads.
 *
 * Onboarding used to be "create a fine-grained token, scope it, paste it" —
 * a wall that had a welcome banner, a help link and a token-type badge built
 * against it. With a GitHub App configured that becomes sign in, pick a repo.
 * The token path stays, one `<details>` down, because existing installs use it
 * and a fork with no App of its own has nothing else.
 */

/** What the repository picker has to show, which is mostly not a list. */
type Repos =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "failed"; message: string }
  | { kind: "list"; repos: RepoRef[] };

export async function renderAuthPanel(
  host: HTMLElement,
  onConnected: () => void,
  /** "Sync now", offered once connected. Settings owns the sync and its status. */
  onSync?: () => Promise<void>
): Promise<void> {
  const config = getConfig();
  const state = {
    credential: await loadCredential(),
    /** The form's fields, which the repo picker also writes to. */
    token: "",
    owner: config?.owner ?? "",
    repo: config?.repo ?? "",
    branch: config?.branch ?? "main",
    status: null as { message: string; error: boolean } | null,
    repos: { kind: "loading" } as Repos,
    syncing: false,
  };

  const paint = () => render(view(), host);
  const say = (message: string, error = false) => {
    state.status = { message, error };
    paint();
  };

  const draft = (): GitHubConfig => ({
    owner: state.owner.trim(),
    repo: state.repo.trim(),
    branch: state.branch.trim() || "main",
  });

  async function verify(): Promise<void> {
    say("Checking connection…");
    try {
      const connection = await inspectConnection();
      let detail = `Connected as ${connection.username}.`;
      if (connection.credential === "classic") {
        detail += ` Classic token${
          connection.scopes ? ` (scopes: ${connection.scopes})` : ""
        } — a fine-grained token scoped to one repo would be safer.`;
      }
      say(detail);
      onConnected();
    } catch (e) {
      say((e as Error).message, true);
    }
  }

  async function connectWithToken(): Promise<void> {
    const manual = draft();
    if (!state.token.trim()) {
      say("Paste a personal access token first.", true);
      return;
    }
    if (!manual.owner || !manual.repo) {
      say("Fill in the repository owner and name.", true);
      return;
    }
    await saveCredential({ kind: "pat", token: state.token.trim() });
    saveConfig(manual);
    state.credential = await loadCredential();
    await verify();
  }

  async function testConnection(): Promise<void> {
    // Blank means "leave the stored one alone" — the field is never populated
    // with the current token, so there is nothing to preserve by typing it out.
    if (state.token.trim()) {
      await saveCredential({ kind: "pat", token: state.token.trim() });
    }
    const manual = draft();
    if (manual.owner && manual.repo) saveConfig(manual);
    await verify();
  }

  async function chooseRepo(full: string): Promise<void> {
    if (state.repos.kind !== "list") return;
    const chosen = state.repos.repos.find((r) => `${r.owner}/${r.repo}` === full);
    if (!chosen) return;
    // The repo's own default branch, not whatever was left in the field from
    // the last repository — picking `main` for a repo whose branch is `master`
    // fails with a 404 that reads like a permissions problem. The manual fields
    // below follow along because they read the same state; they used to be
    // assigned one by one, and a field added to the form was a field left
    // stale.
    state.owner = chosen.owner;
    state.repo = chosen.repo;
    state.branch = chosen.defaultBranch;
    saveConfig(draft());
    paint();
    await verify();
  }

  // --- The three states ---

  function view(): TemplateResult {
    return html`<div class="auth-panel">
      ${state.credential ? connected() : signedOut()}
      <div
        class="auth-status ${state.status?.error ? "auth-status-error" : ""}"
        id="auth-status"
        role="status"
      >
        ${state.status?.message ?? ""}
      </div>
    </div>`;
  }

  function signedOut(): TemplateResult {
    if (!signInAvailable()) {
      return html`<div class="list">
        <div class="disclosure-body">
          <p class="auth-lead auth-note">
            Connect the GitHub repository your cards live in.
          </p>
          ${patFields("Connect")}
        </div>
      </div>`;
    }
    return html`<div class="auth-signin">
      <button
        type="button"
        id="signin-btn"
        class="btn btn-primary btn-lg btn-block btn-signin"
        @click=${() => {
          say("Redirecting to GitHub…");
          beginSignIn();
        }}
      >
        Sign in with GitHub
      </button>
      <p class="auth-lead group-note">
        Hashcards can reach only the repositories you pick, with a token that
        expires — revoke it any time by uninstalling the app on GitHub.
      </p>
      <details class="list disclosure auth-fallback">
        <summary class="row row-action">
          Use a personal access token instead${icon("chevron", 18)}
        </summary>
        <div class="disclosure-body">${patFields("Connect")}</div>
      </details>
    </div>`;
  }

  async function disconnect(): Promise<void> {
    await signOut();
    state.credential = null;
    state.status = null;
    paint();
  }

  /**
   * Connected, the panel is three rows: who, sync, sign out. Everything that
   * set the connection up — the repository, the branch, the token — folds
   * away behind one more, open only while there is no repository yet.
   */
  function connected(): TemplateResult {
    const app = state.credential?.kind === "app";
    const login = app && state.credential?.kind === "app" ? state.credential.login : null;
    const name = app ? (login ?? "GitHub") : "Personal access token";
    const synced = getLastSyncedAt();
    const repo = getConfig();
    const how = app ? "Signed in with GitHub" : repo ? `${repo.owner}/${repo.repo}` : "No repository yet";
    return html`<div class="list">
      <div class="row account auth-identity">
        <span class="avatar" aria-hidden="true">${name.charAt(0).toUpperCase()}</span>
        <span class="row-text">
          <span class="row-title">${name}</span>
          <span class="row-sub"
            >${synced ? `${how} · synced ${formatSyncAge(synced)}` : how}</span
          >
        </span>
      </div>
      <details class="disclosure" ?open=${!repo}>
        <summary class="row row-action">
          ${app ? "Repository" : "Token and repository"}${repo
            ? html`<span class="row-sub">${repo.repo}</span>`
            : ""}${icon("chevron", 18)}
        </summary>
        <div class="disclosure-body">
          ${app
            ? html`<div class="field-group">
                  <label for="repo-select">Repository</label>
                  <div id="repo-picker">${repoPicker()}</div>
                  <a
                    href=${installUrl()}
                    target="_blank"
                    rel="noopener"
                    class="auth-link"
                    >Add or remove repositories on GitHub</a
                  >
                </div>
                ${branchField()}
                <details class="auth-fallback">
                  <summary class="link-btn">Enter a repository manually</summary>
                  <div class="disclosure-body">${repoFields()}</div>
                </details>`
            : patFields("Test connection")}
        </div>
      </details>
      ${onSync
        ? html`<button
            type="button"
            id="sync-btn"
            class="row row-action"
            ?disabled=${state.syncing}
            @click=${async () => {
              state.syncing = true;
              paint();
              try {
                await onSync();
              } finally {
                state.syncing = false;
                paint();
              }
            }}
          >
            ${state.syncing ? "Syncing…" : "Sync now"}
          </button>`
        : nothing}
      <button
        type="button"
        id="signout-btn"
        class="row row-action row-danger"
        @click=${() => void disconnect()}
      >
        ${app ? "Sign out" : "Disconnect"}
      </button>
    </div>`;
  }

  function patFields(action: string): TemplateResult {
    const testing = action === "Test connection";
    return html`<div class="field-group">
        <label for="pat">GitHub Personal Access Token</label>
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noopener"
          class="pat-help-link"
          >Create a fine-grained token</a
        >
        <input
          type="password"
          id="pat"
          autocomplete="off"
          placeholder=${testing
            ? "Stored — type a new one to replace it"
            : "github_pat_…"}
          .value=${state.token}
          @input=${(e: Event) => {
            state.token = (e.target as HTMLInputElement).value;
          }}
        />
      </div>
      ${repoFields()} ${branchField()}
      <button
        type="button"
        class="btn btn-primary btn-block"
        id=${testing ? "test-connection-btn" : "connect-pat-btn"}
        @click=${() => void (testing ? testConnection() : connectWithToken())}
      >
        ${action}
      </button>`;
  }

  function repoFields(): TemplateResult {
    return html`<label>
        Repository Owner
        <input
          type="text"
          id="owner"
          .value=${state.owner}
          placeholder="username"
          @input=${(e: Event) => {
            state.owner = (e.target as HTMLInputElement).value;
          }}
        />
      </label>
      <label>
        Repository Name
        <input
          type="text"
          id="repo"
          .value=${state.repo}
          placeholder="my-flashcards"
          @input=${(e: Event) => {
            state.repo = (e.target as HTMLInputElement).value;
          }}
        />
      </label>`;
  }

  function branchField(): TemplateResult {
    return html`<label>
      Branch
      <input
        type="text"
        id="branch"
        .value=${state.branch}
        placeholder="main"
        @input=${(e: Event) => {
          state.branch = (e.target as HTMLInputElement).value;
        }}
        @change=${() => {
          const manual = draft();
          if (manual.owner && manual.repo) saveConfig(manual);
        }}
      />
    </label>`;
  }

  /**
   * Settings has to work offline — it is where you go to find out *why* nothing
   * is syncing — so every way this can fail degrades to the manual owner/repo
   * fields rather than leaving the page half-rendered.
   */
  function repoPicker(): TemplateResult {
    if (state.repos.kind === "loading") {
      return html`<span>Loading repositories…</span>`;
    }
    if (state.repos.kind === "offline") {
      return html`<p class="auth-note">
        Offline — reconnect to list your repositories.
      </p>`;
    }
    if (state.repos.kind === "failed") {
      return html`<p class="auth-note">
        Could not list repositories: ${state.repos.message}
      </p>`;
    }
    if (state.repos.repos.length === 0) {
      return html`<p class="auth-note">
          This account has not given Hashcards access to any repository yet.
        </p>
        <a href=${installUrl()} target="_blank" rel="noopener" class="btn btn-small"
          >Choose repositories</a
        >`;
    }
    const selected = `${state.owner}/${state.repo}`;
    return html`<select
      id="repo-select"
      @change=${(e: Event) => void chooseRepo((e.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!state.owner}>Choose a repository…</option>
      ${state.repos.repos.map((r) => {
        const full = `${r.owner}/${r.repo}`;
        return html`<option value=${full} ?selected=${full === selected}>
          ${full}${r.private ? " (private)" : ""}
        </option>`;
      })}
    </select>`;
  }

  paint();

  if (state.credential?.kind === "app") {
    if (!navigator.onLine) {
      state.repos = { kind: "offline" };
    } else {
      try {
        state.repos = { kind: "list", repos: await listAccessibleRepos() };
      } catch (e) {
        state.repos = { kind: "failed", message: (e as Error).message };
      }
    }
    paint();
  }
}
