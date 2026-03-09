import { getConfig, saveConfig, listMdFiles, getNewCardsPerDay, setNewCardsPerDay, getIntervalFuzz, setIntervalFuzz, getHapticFeedback, setHapticFeedback, inspectToken, GitHubConfig } from "../github";
import { syncCards, fullSync } from "../sync";

export function renderSettings(
  container: HTMLElement,
  onDone: () => void
): void {
  const config = getConfig();
  const newPerDay = getNewCardsPerDay();
  const fuzzOn = getIntervalFuzz();
  const hapticOn = getHapticFeedback();

  const isFirstRun = !config;

  container.innerHTML = `
    <div class="settings-view">
      <h1>Settings</h1>
      ${isFirstRun ? `
      <div class="welcome-banner">
        <p><strong>Hashcards</strong> is a spaced repetition flashcard app. Cards live as <code>.md</code> files in a GitHub repo, and the app syncs them via the GitHub API.</p>
        <p><strong>Get started in 3 steps:</strong></p>
        <ol>
          <li>Create a GitHub repo with <code>.md</code> flashcard files (<a href="https://github.com/eudoxia0/hashcards#format" target="_blank" rel="noopener">card format</a>)</li>
          <li>Generate a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained PAT</a> — select only your repo, grant <strong>Contents: Read and write</strong></li>
          <li>Enter your details below and click <strong>Test Connection</strong></li>
        </ol>
      </div>
      ` : ""}
      <form id="settings-form">
        <label>
          GitHub Personal Access Token
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="pat-help-link">Create a fine-grained token</a>
          <input type="password" id="pat" value="${config?.pat || ""}" placeholder="github_pat_... or ghp_..." />
          <div id="token-info"></div>
        </label>
        <label>
          Repository Owner
          <input type="text" id="owner" value="${config?.owner || ""}" placeholder="username" />
        </label>
        <label>
          Repository Name
          <input type="text" id="repo" value="${config?.repo || ""}" placeholder="my-flashcards" />
        </label>
        <label>
          Branch
          <input type="text" id="branch" value="${config?.branch || "main"}" placeholder="main" />
        </label>
        <label>
          New cards per day
          <input type="number" id="new-per-day" value="${newPerDay}" min="1" max="999" />
        </label>
        <label class="toggle-label">
          <input type="checkbox" id="interval-fuzz" ${fuzzOn ? "checked" : ""} />
          Interval fuzz (vary intervals slightly to avoid clustering)
        </label>
        <label class="toggle-label">
          <input type="checkbox" id="haptic-feedback" ${hapticOn ? "checked" : ""} />
          Haptic feedback on grade buttons
        </label>
        <div class="settings-buttons">
          <button type="button" id="test-btn">Test Connection</button>
          <button type="button" id="sync-btn">Sync Now</button>
          ${config ? '<button type="button" id="back-btn">Back to Decks</button>' : ""}
        </div>
        <div id="settings-status"></div>
      </form>
      <div class="settings-footer">
        <div class="settings-version">hashcards ${__COMMIT_HASH__}</div>
        <a href="https://github.com/danielmeint/hashcards-app" target="_blank" rel="noopener">GitHub</a>
      </div>
    </div>
  `;

  const statusEl = container.querySelector("#settings-status") as HTMLElement;

  function getFormConfig(): GitHubConfig {
    return {
      pat: (container.querySelector("#pat") as HTMLInputElement).value.trim(),
      owner: (container.querySelector("#owner") as HTMLInputElement).value.trim(),
      repo: (container.querySelector("#repo") as HTMLInputElement).value.trim(),
      branch: (container.querySelector("#branch") as HTMLInputElement).value.trim() || "main",
    };
  }

  function savePrefs(): void {
    const val = parseInt((container.querySelector("#new-per-day") as HTMLInputElement).value, 10);
    if (val > 0) setNewCardsPerDay(val);
    setIntervalFuzz((container.querySelector("#interval-fuzz") as HTMLInputElement).checked);
    setHapticFeedback((container.querySelector("#haptic-feedback") as HTMLInputElement).checked);
  }

  const tokenInfoEl = container.querySelector("#token-info") as HTMLElement;

  function renderTokenInfo(cfg: GitHubConfig): void {
    const pat = cfg.pat;
    if (!pat) {
      tokenInfoEl.innerHTML = "";
      return;
    }
    if (pat.startsWith("ghp_")) {
      tokenInfoEl.innerHTML = `<span class="token-warning">Classic token — consider using a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> scoped to just your repo.</span>`;
    } else if (pat.startsWith("github_pat_")) {
      tokenInfoEl.innerHTML = `<span class="token-ok">Fine-grained token</span>`;
    } else {
      tokenInfoEl.innerHTML = "";
    }
  }

  // Show token type on load
  if (config) renderTokenInfo(config);

  // Update on input change
  container.querySelector("#pat")!.addEventListener("input", () => {
    renderTokenInfo(getFormConfig());
  });

  container.querySelector("#test-btn")!.addEventListener("click", async () => {
    const cfg = getFormConfig();
    if (!cfg.pat || !cfg.owner || !cfg.repo) {
      statusEl.textContent = "Please fill in all fields.";
      return;
    }
    statusEl.textContent = "Testing connection...";
    try {
      const [files, tokenInfo] = await Promise.all([
        listMdFiles(cfg),
        inspectToken(cfg),
      ]);
      saveConfig(cfg);
      savePrefs();

      let detail = `Connected as ${tokenInfo.username}. Found ${files.length} .md file${files.length === 1 ? "" : "s"}.`;
      if (tokenInfo.tokenType === "classic" && tokenInfo.scopes) {
        detail += ` Scopes: ${tokenInfo.scopes}.`;
      }
      statusEl.textContent = detail;

      // Update token info badge after successful auth
      if (tokenInfo.tokenType === "fine-grained") {
        tokenInfoEl.innerHTML = `<span class="token-ok">Fine-grained token — ${tokenInfo.username}</span>`;
      } else if (tokenInfo.tokenType === "classic") {
        tokenInfoEl.innerHTML = `<span class="token-warning">Classic token (${tokenInfo.username}) — consider using a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> scoped to just your repo.</span>`;
      }
    } catch (e) {
      statusEl.textContent = `${(e as Error).message}`;
    }
  });

  container.querySelector("#sync-btn")!.addEventListener("click", async () => {
    const cfg = getFormConfig();
    if (!cfg.pat || !cfg.owner || !cfg.repo) {
      statusEl.textContent = "Please fill in all fields.";
      return;
    }
    const syncBtn = container.querySelector("#sync-btn") as HTMLButtonElement;
    const testBtn = container.querySelector("#test-btn") as HTMLButtonElement;
    syncBtn.disabled = true;
    testBtn.disabled = true;

    try {
      saveConfig(cfg);
      savePrefs();
      const cards = await syncCards(cfg, (p) => {
        if (p.current && p.total) {
          statusEl.textContent = `${p.phase}... (${p.current}/${p.total})`;
        } else {
          statusEl.textContent = `${p.phase}...`;
        }
      });
      statusEl.textContent = `Synced ${cards.length} cards. Syncing state...`;
      await fullSync(cfg, (p) => {
        statusEl.textContent = `${p.phase}...`;
      });
      statusEl.textContent = `Done! ${cards.length} cards synced.`;
      if (isFirstRun) onDone();
    } catch (e) {
      statusEl.textContent = `${(e as Error).message}`;
    } finally {
      syncBtn.disabled = false;
      testBtn.disabled = false;
    }
  });

  container.querySelector("#back-btn")?.addEventListener("click", () => {
    savePrefs();
    onDone();
  });
}
