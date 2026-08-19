import { getAccessToken, loadCredential, recordLogin, refreshCredential } from "./auth";

/**
 * Which repository to read cards from. Deliberately carries no credential: the
 * token is fetched inside `apiFetch` instead, so it never travels through the
 * views, the sync runner, or an error message on its way to a request.
 */
export type GitHubConfig = {
  owner: string;
  repo: string;
  branch: string;
};

export function getConfig(): GitHubConfig | null {
  const owner = localStorage.getItem("github_owner");
  const repo = localStorage.getItem("github_repo");
  const branch = localStorage.getItem("github_branch") || "main";
  if (!owner || !repo) return null;
  return { owner, repo, branch };
}

export function saveConfig(config: GitHubConfig): void {
  localStorage.setItem("github_owner", config.owner);
  localStorage.setItem("github_repo", config.repo);
  localStorage.setItem("github_branch", config.branch);
}

export function getIntervalFuzz(): boolean {
  return localStorage.getItem("interval_fuzz") !== "false"; // default on
}

export function setIntervalFuzz(on: boolean): void {
  localStorage.setItem("interval_fuzz", String(on));
}

export function getHapticFeedback(): boolean {
  return localStorage.getItem("haptic_feedback") !== "false"; // default on
}

export function setHapticFeedback(on: boolean): void {
  localStorage.setItem("haptic_feedback", String(on));
}

/**
 * Every GitHub call goes through here, so no caller ever handles a token.
 *
 * A 401 buys one refresh-and-retry. An App token can expire between the check
 * in `getAccessToken` and the request landing, and it can be renewed without
 * involving the user at all — a sync failure for something we can fix ourselves
 * is not worth showing anyone.
 */
async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const send = (token: string) =>
    fetch(`https://api.github.com${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    });

  const res = await send(await getAccessToken());
  if (res.status !== 401) return res;
  const renewed = await refreshCredential();
  return renewed ? send(renewed) : res;
}

export type Connection = {
  /** How this install authenticates — and for a PAT, which kind of one. */
  credential: "app" | "fine-grained" | "classic";
  username: string;
  /** Classic tokens only; fine-grained and App tokens have no scope list. */
  scopes: string | null;
};

/** Who the stored credential belongs to, and what kind of credential it is. */
export async function inspectConnection(): Promise<Connection> {
  const res = await apiFetch("/user");
  if (!res.ok) throw new Error(await apiError(res));
  const data = await res.json();

  // Classic tokens carry `x-oauth-scopes` on every response and fine-grained
  // ones never do. That is a property of the token rather than of its text,
  // unlike the `ghp_` / `github_pat_` prefix this used to guess from — which
  // said nothing about a token GitHub had already rejected or reissued.
  const scopes = res.headers.get("x-oauth-scopes");
  const credential = await loadCredential();

  if (credential?.kind === "app") await recordLogin(data.login);

  return {
    credential:
      credential?.kind === "app"
        ? "app"
        : scopes !== null
        ? "classic"
        : "fine-grained",
    username: data.login,
    scopes,
  };
}

async function apiError(res: Response): Promise<string> {
  if (res.status === 401) {
    return "GitHub rejected the credential. Reconnect in Settings.";
  }
  if (res.status === 403) {
    return "Permission denied. The credential lacks Contents: Read and write on this repository.";
  }
  if (res.status === 404) {
    return "Repository not found. Check owner, repo name, and branch.";
  }
  try {
    const data = await res.json();
    return data.message || `GitHub API error: ${res.status}`;
  } catch {
    return `GitHub API error: ${res.status}`;
  }
}

// --- Picking a repository ---

export type RepoRef = {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
};

type Installation = { id: number };

/**
 * Every repository reachable through the GitHub App, across every installation
 * the signed-in user can see. This is the list behind the repo picker, and it
 * is exactly the set of repos the token can touch — installing the App on more
 * repositories is how it grows.
 *
 * Only meaningful for an App credential. A PAT has no installations, so this
 * comes back empty and Settings falls back to typing owner and repo.
 */
export async function listAccessibleRepos(): Promise<RepoRef[]> {
  const res = await apiFetch("/user/installations?per_page=100");
  if (!res.ok) throw new Error(await apiError(res));
  const { installations } = (await res.json()) as {
    installations: Installation[];
  };

  const repos: RepoRef[] = [];
  for (const installation of installations) {
    repos.push(...(await listInstallationRepos(installation.id)));
  }
  repos.sort((a, b) =>
    `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`)
  );
  return repos;
}

/** At 100 per page, five pages is 500 repositories — well past useful in a picker. */
const MAX_REPO_PAGES = 5;

async function listInstallationRepos(id: number): Promise<RepoRef[]> {
  const repos: RepoRef[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const res = await apiFetch(
      `/user/installations/${id}/repositories?per_page=100&page=${page}`
    );
    if (!res.ok) throw new Error(await apiError(res));
    const data = (await res.json()) as {
      repositories: {
        name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
      }[];
    };
    for (const repo of data.repositories) {
      repos.push({
        owner: repo.owner.login,
        repo: repo.name,
        defaultBranch: repo.default_branch,
        private: repo.private,
      });
    }
    if (data.repositories.length < 100) break;
  }
  return repos;
}

// --- Cards and state ---

export type FileEntry = {
  path: string;
  sha: string;
};

export type TreeListing =
  /** The tree is byte-for-byte what the caller already has. */
  | { changed: false }
  | { changed: true; files: FileEntry[]; etag: string | null };

/**
 * List the repo's Markdown files, with each file's blob SHA so a caller can
 * tell which ones actually changed.
 *
 * Pass the ETag from a previous call to make the request conditional. The
 * overwhelmingly common case is that nothing has changed since the last sync,
 * and GitHub answers that with a 304 that costs one round trip and does not
 * count against the rate limit.
 */
export async function listMdFiles(
  config: GitHubConfig,
  etag?: string | null
): Promise<TreeListing> {
  const res = await apiFetch(
    `/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`,
    etag ? { headers: { "If-None-Match": etag } } : undefined
  );
  if (res.status === 304) return { changed: false };
  if (!res.ok) throw new Error(await apiError(res));
  const data = await res.json();
  const files: FileEntry[] = data.tree
    .filter(
      (item: { path: string; type: string }) =>
        item.type === "blob" && item.path.endsWith(".md")
    )
    .map((item: { path: string; sha: string }) => ({
      path: item.path,
      sha: item.sha,
    }));
  return { changed: true, files, etag: res.headers.get("etag") };
}

export async function getFileContent(
  config: GitHubConfig,
  path: string
): Promise<string> {
  const res = await apiFetch(
    `/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`
  );
  if (!res.ok) throw new Error(await apiError(res));
  const data = await res.json();
  return decodeBase64(data.content);
}

function decodeBase64(content: string): string {
  const binary = atob(content.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export type SyncProgress = {
  phase: string;
  current?: number;
  total?: number;
};

export async function getFilesContent(
  config: GitHubConfig,
  paths: string[],
  onProgress?: (progress: SyncProgress) => void
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const concurrency = 5;

  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const contents = await Promise.all(
      batch.map((p) => getFileContent(config, p))
    );
    batch.forEach((p, idx) => results.set(p, contents[idx]));
    onProgress?.({
      phase: "Fetching files",
      current: Math.min(i + concurrency, paths.length),
      total: paths.length,
    });
  }

  return results;
}

export type StateFile = {
  version: number;
  cards: Record<
    string,
    {
      lastReviewedAt: string;
      stability: number;
      difficulty: number;
      intervalRaw: number;
      intervalDays: number;
      dueDate: string;
      reviewCount: number;
    }
  >;
};

export async function readStateFile(
  config: GitHubConfig
): Promise<{ data: StateFile; sha: string } | null> {
  const res = await apiFetch(
    `/repos/${config.owner}/${config.repo}/contents/hashcards-state.json?ref=${config.branch}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await apiError(res));
  const data = await res.json();
  return { data: JSON.parse(decodeBase64(data.content)), sha: data.sha };
}

export async function writeStateFile(
  config: GitHubConfig,
  state: StateFile,
  sha?: string
): Promise<void> {
  const content = btoa(JSON.stringify(state, null, 2));
  const body: Record<string, unknown> = {
    message: "Update hashcards state",
    content,
    branch: config.branch,
  };
  if (sha) body.sha = sha;

  const res = await apiFetch(
    `/repos/${config.owner}/${config.repo}/contents/hashcards-state.json`,
    { method: "PUT", body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(await apiError(res));
}
