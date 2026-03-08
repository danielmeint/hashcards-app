import { getConfig, saveConfig, listMdFiles, GitHubConfig } from "../github";
import { syncCards, fullSync } from "../sync";

export function renderSettings(
  container: HTMLElement,
  onDone: () => void
): void {
  const config = getConfig();

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
        <div class="settings-buttons">
          <button type="button" id="test-btn">Test Connection</button>
          <button type="button" id="sync-btn">Sync Now</button>
          ${config ? '<button type="button" id="back-btn">Back to Decks</button>' : ""}
        </div>
        <div id="settings-status"></div>
      </form>
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
      statusEl.textContent = `Connected! Found ${files.length} .md files.`;
    } catch (e) {
      statusEl.textContent = `Error: ${(e as Error).message}`;
    }
  });

  container.querySelector("#sync-btn")!.addEventListener("click", async () => {
    const cfg = getFormConfig();
    if (!cfg.pat || !cfg.owner || !cfg.repo) {
      statusEl.textContent = "Please fill in all fields.";
      return;
    }
    statusEl.textContent = "Syncing cards...";
    try {
      saveConfig(cfg);
      const cards = await syncCards(cfg);
      statusEl.textContent = `Synced ${cards.length} cards. Syncing state...`;
      await fullSync(cfg);
      statusEl.textContent = `Done! ${cards.length} cards synced.`;
    } catch (e) {
      statusEl.textContent = `Error: ${(e as Error).message}`;
    }
  });

  container.querySelector("#back-btn")?.addEventListener("click", onDone);
}
