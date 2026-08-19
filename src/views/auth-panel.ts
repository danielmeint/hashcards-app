import { html, render, TemplateResult } from "lit-html";
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
  onConnected: () => void
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
      >
        ${state.status?.message ?? ""}
      </div>
    </div>`;
  }

  function signedOut(): TemplateResult {
    if (!signInAvailable()) {
      return html`<p class="auth-lead">
          Connect the GitHub repository your cards live in.
        </p>
        ${patFields("Connect")}`;
    }
    return html`<button
        type="button"
        id="signin-btn"
        class="btn btn-primary btn-signin"
        @click=${() => {
          say("Redirecting to GitHub…");
          beginSignIn();
        }}
      >
        Sign in with GitHub
      </button>
      <p class="auth-lead">
        Hashcards can reach only the repositories you pick, with a token that
        expires — revoke it any time by uninstalling the app on GitHub.
      </p>
      <details class="auth-fallback">
        <summary>Use a personal access token instead</summary>
        ${patFields("Connect")}
      </details>`;
  }

  function connected(): TemplateResult {
    if (state.credential?.kind === "app") {
      const who = state.credential.login
        ? `@${state.credential.login}`
        : "GitHub";
      return html`<div class="auth-identity">
          <span>Signed in as <strong>${who}</strong></span>
          <button
            type="button"
            id="signout-btn"
            class="btn btn-small"
            @click=${async () => {
              await signOut();
              state.credential = null;
              state.status = null;
              paint();
            }}
          >
            Sign out
          </button>
        </div>
        <div class="field-group">
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
          <summary>Enter a repository manually</summary>
          ${repoFields()}
        </details>`;
    }
    return html`<div class="auth-identity">
        <span>Connected with a personal access token</span>
        <button
          type="button"
          id="signout-btn"
          class="btn btn-small"
          @click=${async () => {
            await signOut();
            state.credential = null;
            state.status = null;
            paint();
          }}
        >
          Disconnect
        </button>
      </div>
      ${patFields("Test connection")}`;
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
        class="btn btn-primary"
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
        <a href=${installUrl()} target="_blank" rel="noopener" class="btn"
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
