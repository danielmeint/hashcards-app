import {
  GitHubConfig,
  RepoRef,
  getConfig,
  inspectConnection,
  listAccessibleRepos,
  saveConfig,
} from "../github";
import {
  Credential,
  beginSignIn,
  loadCredential,
  saveCredential,
  signOut,
} from "../auth";
import { installUrl, signInAvailable } from "../github-app";
import { escapeHtml } from "../escape";

/**
 * The connection half of Settings: how the app authenticates, and which
 * repository it reads.
 *
 * Onboarding used to be "create a fine-grained token, scope it, paste it" —
 * a wall that had a welcome banner, a help link and a token-type badge built
 * against it. With a GitHub App configured that becomes sign in, pick a repo.
 * The token path stays, one `<details>` down, because existing installs use it
 * and a fork with no App of its own has nothing else.
 *
 * Renders itself into `host` and re-renders in place on every change, so
 * callers never track which of the three states it is in.
 */
export async function renderAuthPanel(
  host: HTMLElement,
  onConnected: () => void
): Promise<void> {
  const credential = await loadCredential();
  const config = getConfig();
  const rerender = () => void renderAuthPanel(host, onConnected);

  host.innerHTML = `
    <div class="auth-panel">
      ${credential ? connected(credential, config) : signedOut()}
      <div class="auth-status" id="auth-status"></div>
    </div>
  `;

  const status = host.querySelector("#auth-status") as HTMLElement;
  const say = (message: string, error = false) => {
    status.textContent = message;
    status.classList.toggle("auth-status-error", error);
  };

  host.querySelector("#signin-btn")?.addEventListener("click", () => {
    say("Redirecting to GitHub…");
    beginSignIn();
  });

  host.querySelector("#signout-btn")?.addEventListener("click", async () => {
    await signOut();
    rerender();
  });

  host.querySelector("#connect-pat-btn")?.addEventListener("click", async () => {
    const token = value(host, "#pat");
    const manual = manualConfig(host);
    if (!token) {
      say("Paste a personal access token first.", true);
      return;
    }
    if (!manual.owner || !manual.repo) {
      say("Fill in the repository owner and name.", true);
      return;
    }
    await saveCredential({ kind: "pat", token });
    saveConfig(manual);
    await verify(say, onConnected);
    rerender();
  });

  host.querySelector("#test-connection-btn")?.addEventListener("click", async () => {
    const token = value(host, "#pat");
    // Blank means "leave the stored one alone" — the field is never populated
    // with the current token, so there is nothing to preserve by typing it out.
    if (token) await saveCredential({ kind: "pat", token });
    const manual = manualConfig(host);
    if (manual.owner && manual.repo) saveConfig(manual);
    await verify(say, onConnected);
  });

  host.querySelector("#branch")?.addEventListener("change", () => {
    const current = getConfig();
    if (current) saveConfig({ ...current, branch: value(host, "#branch") || "main" });
  });

  if (credential?.kind === "app") {
    await mountRepoPicker(host, say, onConnected);
  }
}

// --- The three states ---

function signedOut(): string {
  const pat = patFields(null, "Connect");
  if (!signInAvailable()) {
    return `
      <p class="auth-lead">Connect the GitHub repository your cards live in.</p>
      ${pat}
    `;
  }
  return `
    <button type="button" id="signin-btn" class="btn btn-primary btn-signin">
      Sign in with GitHub
    </button>
    <p class="auth-lead">
      Hashcards can reach only the repositories you pick, with a token that
      expires — revoke it any time by uninstalling the app on GitHub.
    </p>
    <details class="auth-fallback">
      <summary>Use a personal access token instead</summary>
      ${pat}
    </details>
  `;
}

function connected(credential: Credential, config: GitHubConfig | null): string {
  if (credential.kind === "app") {
    const who = credential.login ? `@${escapeHtml(credential.login)}` : "GitHub";
    return `
      <div class="auth-identity">
        <span>Signed in as <strong>${who}</strong></span>
        <button type="button" id="signout-btn" class="btn btn-small">Sign out</button>
      </div>
      <div class="field-group">
        <label for="repo-select">Repository</label>
        <div id="repo-picker">Loading repositories…</div>
        <a href="${installUrl()}" target="_blank" rel="noopener" class="auth-link">
          Add or remove repositories on GitHub
        </a>
      </div>
      ${branchField(config)}
      <details class="auth-fallback">
        <summary>Enter a repository manually</summary>
        ${repoFields(config)}
      </details>
    `;
  }
  return `
    <div class="auth-identity">
      <span>Connected with a personal access token</span>
      <button type="button" id="signout-btn" class="btn btn-small">Disconnect</button>
    </div>
    ${patFields(config, "Test connection")}
  `;
}

function patFields(config: GitHubConfig | null, action: string): string {
  const testing = action === "Test connection";
  return `
    <div class="field-group">
      <label for="pat">GitHub Personal Access Token</label>
      <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="pat-help-link">Create a fine-grained token</a>
      <input type="password" id="pat" autocomplete="off"
             placeholder="${testing ? "Stored — type a new one to replace it" : "github_pat_…"}" />
    </div>
    ${repoFields(config)}
    ${branchField(config)}
    <button type="button" class="btn btn-primary"
            id="${testing ? "test-connection-btn" : "connect-pat-btn"}">${action}</button>
  `;
}

function repoFields(config: GitHubConfig | null): string {
  return `
    <label>
      Repository Owner
      <input type="text" id="owner" value="${escapeHtml(config?.owner ?? "")}" placeholder="username" />
    </label>
    <label>
      Repository Name
      <input type="text" id="repo" value="${escapeHtml(config?.repo ?? "")}" placeholder="my-flashcards" />
    </label>
  `;
}

function branchField(config: GitHubConfig | null): string {
  return `
    <label>
      Branch
      <input type="text" id="branch" value="${escapeHtml(config?.branch ?? "main")}" placeholder="main" />
    </label>
  `;
}

// --- The repo picker ---

/**
 * Fills the picker in behind the panel rather than blocking on it. Settings has
 * to work offline — it is where you go to find out *why* nothing is syncing —
 * so a failure here degrades to the manual owner/repo fields rather than
 * leaving the page half-rendered.
 */
async function mountRepoPicker(
  host: HTMLElement,
  say: (message: string, error?: boolean) => void,
  onConnected: () => void
): Promise<void> {
  const picker = host.querySelector("#repo-picker") as HTMLElement;
  if (!picker) return;

  if (!navigator.onLine) {
    picker.innerHTML = `<p class="auth-note">Offline — reconnect to list your repositories.</p>`;
    return;
  }

  let repos: RepoRef[];
  try {
    repos = await listAccessibleRepos();
  } catch (e) {
    picker.innerHTML = `<p class="auth-note">Could not list repositories: ${escapeHtml(
      (e as Error).message
    )}</p>`;
    return;
  }

  if (repos.length === 0) {
    picker.innerHTML = `
      <p class="auth-note">This account has not given Hashcards access to any repository yet.</p>
      <a href="${installUrl()}" target="_blank" rel="noopener" class="btn">Choose repositories</a>
    `;
    return;
  }

  const current = getConfig();
  const selected = current ? `${current.owner}/${current.repo}` : "";
  picker.innerHTML = `
    <select id="repo-select">
      <option value=""${selected ? "" : " selected"}>Choose a repository…</option>
      ${repos
        .map((r) => {
          const full = `${r.owner}/${r.repo}`;
          return `<option value="${escapeHtml(full)}"${
            full === selected ? " selected" : ""
          }>${escapeHtml(full)}${r.private ? " (private)" : ""}</option>`;
        })
        .join("")}
    </select>
  `;

  picker.querySelector("#repo-select")!.addEventListener("change", async (e) => {
    const full = (e.target as HTMLSelectElement).value;
    if (!full) return;
    const chosen = repos.find((r) => `${r.owner}/${r.repo}` === full)!;
    // The repo's own default branch, not whatever was left in the field from
    // the last repository — picking `main` for a repo whose branch is `master`
    // fails with a 404 that reads like a permissions problem.
    saveConfig({
      owner: chosen.owner,
      repo: chosen.repo,
      branch: chosen.defaultBranch,
    });
    const branch = host.querySelector("#branch") as HTMLInputElement | null;
    if (branch) branch.value = chosen.defaultBranch;
    const owner = host.querySelector("#owner") as HTMLInputElement | null;
    if (owner) owner.value = chosen.owner;
    const repo = host.querySelector("#repo") as HTMLInputElement | null;
    if (repo) repo.value = chosen.repo;
    await verify(say, onConnected);
  });
}

// --- Shared helpers ---

async function verify(
  say: (message: string, error?: boolean) => void,
  onConnected: () => void
): Promise<void> {
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

function value(host: HTMLElement, selector: string): string {
  const input = host.querySelector(selector) as HTMLInputElement | null;
  return input?.value.trim() ?? "";
}

function manualConfig(host: HTMLElement): GitHubConfig {
  return {
    owner: value(host, "#owner"),
    repo: value(host, "#repo"),
    branch: value(host, "#branch") || "main",
  };
}
