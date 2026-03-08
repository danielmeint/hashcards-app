export type GitHubConfig = {
  pat: string;
  owner: string;
  repo: string;
  branch: string;
};

export function getConfig(): GitHubConfig | null {
  const pat = localStorage.getItem("github_pat");
  const owner = localStorage.getItem("github_owner");
  const repo = localStorage.getItem("github_repo");
  const branch = localStorage.getItem("github_branch") || "main";
  if (!pat || !owner || !repo) return null;
  return { pat, owner, repo, branch };
}

export function saveConfig(config: GitHubConfig): void {
  localStorage.setItem("github_pat", config.pat);
  localStorage.setItem("github_owner", config.owner);
  localStorage.setItem("github_repo", config.repo);
  localStorage.setItem("github_branch", config.branch);
}

async function apiFetch(
  config: GitHubConfig,
  path: string,
  options?: RequestInit
): Promise<Response> {
  const url = `https://api.github.com${path}`;
  return fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${config.pat}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
}

export type FileEntry = {
  path: string;
  sha: string;
};

export async function listMdFiles(config: GitHubConfig): Promise<FileEntry[]> {
  const res = await apiFetch(
    config,
    `/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  return data.tree
    .filter(
      (item: { path: string; type: string }) =>
        item.type === "blob" && item.path.endsWith(".md")
    )
    .map((item: { path: string; sha: string }) => ({
      path: item.path,
      sha: item.sha,
    }));
}

export async function getFileContent(
  config: GitHubConfig,
  path: string
): Promise<string> {
  const res = await apiFetch(
    config,
    `/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} for ${path}`);
  const data = await res.json();
  return atob(data.content.replace(/\n/g, ""));
}

export async function getFilesContent(
  config: GitHubConfig,
  paths: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const concurrency = 5;

  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const contents = await Promise.all(
      batch.map((p) => getFileContent(config, p))
    );
    batch.forEach((p, idx) => results.set(p, contents[idx]));
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
    config,
    `/repos/${config.owner}/${config.repo}/contents/hashcards-state.json?ref=${config.branch}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { data: JSON.parse(content), sha: data.sha };
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
    config,
    `/repos/${config.owner}/${config.repo}/contents/hashcards-state.json`,
    { method: "PUT", body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to write state: ${res.status} ${err}`);
  }
}
