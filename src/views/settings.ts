import { getConfig, saveConfig, listMdFiles, getNewCardsPerDay, setNewCardsPerDay, GitHubConfig } from "../github";
import { syncCards, fullSync } from "../sync";

export function renderSettings(
  container: HTMLElement,
  onDone: () => void
): void {
  const config = getConfig();
  const newPerDay = getNewCardsPerDay();

  container.innerHTML = `
    <div class="settings-view">
      <h1>Settings</h1>
      <form id="settings-form">
        <label>
          GitHub Personal Access Token
          <input type="password" id="pat" value="${config?.pat || ""}" placeholder="ghp_..." />
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
        <div class="settings-buttons">
          <button type="button" id="test-btn">Test Connection</button>
          <button type="button" id="sync-btn">Sync Now</button>
          ${config ? '<button type="button" id="back-btn">Back to Decks</button>' : ""}
        </div>
        <div id="settings-status"></div>
      </form>
      <div class="settings-version">hashcards ${__COMMIT_HASH__}</div>
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

  function saveNewPerDay(): void {
    const val = parseInt((container.querySelector("#new-per-day") as HTMLInputElement).value, 10);
    if (val > 0) setNewCardsPerDay(val);
  }

  container.querySelector("#test-btn")!.addEventListener("click", async () => {
    const cfg = getFormConfig();
    if (!cfg.pat || !cfg.owner || !cfg.repo) {
      statusEl.textContent = "Please fill in all fields.";
      return;
    }
    statusEl.textContent = "Testing connection...";
    try {
      const files = await listMdFiles(cfg);
      saveConfig(cfg);
      saveNewPerDay();
      statusEl.textContent = `Connected! Found ${files.length} .md files.`;
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
      saveNewPerDay();
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
    } catch (e) {
      statusEl.textContent = `${(e as Error).message}`;
    } finally {
      syncBtn.disabled = false;
      testBtn.disabled = false;
    }
  });

  container.querySelector("#back-btn")?.addEventListener("click", () => {
    saveNewPerDay();
    onDone();
  });
}
