import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "./command";

/**
 * Writing commits with git's plumbing, for the commands that change a repo's
 * history (`migrate`, `import anki`).
 *
 * Plumbing rather than `git add` and `git commit` for three reasons. A commit
 * can go on a branch that is not checked out — the data branch never is. Both
 * branches can move in one ref transaction, so a repo is never left with one
 * half of a change. And nothing depends on the person's index, hooks or
 * `commit.gpgsign` doing what we expect: the trees are built in a scratch
 * index and the working tree is moved only once the refs have.
 */

const ZERO = "0".repeat(40);

export function git(
  repo: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {}
): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      input: opts.input,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1 << 30,
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new CommandError(`git ${args[0]} failed: ${stderr || (error as Error).message}`);
  }
}

function tryGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

/** The commit `ref` names, or null when there is no such ref. */
export function resolveRef(repo: string, ref: string): string | null {
  return tryGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim() || null;
}

export function isGitRepo(repo: string): boolean {
  return tryGit(repo, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** The branch HEAD is on (`main`), or null when HEAD is detached. */
export function currentBranch(repo: string): string | null {
  return tryGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || null;
}

/** Every change `git status` would show, untracked files included. */
export function dirtyPaths(repo: string): string[] {
  return git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean);
}

/** Every file in `tree` (a commit or tree) under `dir`, or everywhere. */
export function listFiles(repo: string, tree: string, dir?: string): string[] {
  const args = ["ls-tree", "-r", "--name-only", "-z", tree];
  if (dir !== undefined) args.push("--", dir);
  return git(repo, args).split("\0").filter(Boolean);
}

/** A file's text at `tree`, or null when it is not there. */
export function showFile(repo: string, tree: string, path: string): string | null {
  return tryGit(repo, ["show", `${tree}:${path}`]);
}

/** What a tree should gain (text) or lose (null), by path. */
export type TreeChanges = Map<string, string | null>;

/**
 * A tree: `base` (a commit or tree; null for an empty one) with `changes`
 * applied. Built in a throwaway index, so the repo's own index and working
 * tree are never touched.
 */
export function writeTree(repo: string, base: string | null, changes: TreeChanges): string {
  const dir = mkdtempSync(join(tmpdir(), "hc-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    git(repo, base ? ["read-tree", base] : ["read-tree", "--empty"], { env });
    const lines: string[] = [];
    for (const [path, text] of changes) {
      if (text === null) {
        lines.push(`0 ${ZERO}\t${path}`);
      } else {
        const sha = git(repo, ["hash-object", "-w", "--stdin"], { input: text }).trim();
        lines.push(`100644 ${sha}\t${path}`);
      }
    }
    if (lines.length > 0) {
      git(repo, ["update-index", "--index-info"], { input: lines.join("\n") + "\n", env });
    }
    return git(repo, ["write-tree"], { env }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function commitTree(repo: string, tree: string, parents: string[], message: string): string {
  const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
  return git(repo, args, { input: message }).trim();
}

/**
 * Where a ref should go: `old` is what it must point at now for the update to
 * happen, or null for "must not exist yet".
 */
export type RefUpdate = { ref: string; to: string; old: string | null };

/**
 * Move every ref in `updates`, or none: one `update-ref` transaction, which
 * also re-checks each `old`, so anything that moved since we looked makes the
 * whole thing fail rather than overwrite it.
 */
export function updateRefs(repo: string, updates: RefUpdate[], message: string): void {
  const lines = ["start"];
  for (const { ref, to, old } of updates) lines.push(`update ${ref} ${to} ${old ?? ZERO}`);
  lines.push("prepare", "commit");
  git(repo, ["update-ref", "-m", message, "--stdin"], { input: lines.join("\n") + "\n" });
}

/**
 * Bring the index and working tree from commit `from` to `to`, as a checkout
 * would. Only safe on a clean tree, which is what the callers require.
 */
export function moveWorktree(repo: string, from: string, to: string): void {
  git(repo, ["read-tree", "-m", "-u", from, to]);
}
