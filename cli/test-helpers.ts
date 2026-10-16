import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { main } from "./main";
import type { Io } from "./command";

/** Fixtures for the CLI tests: throwaway repos on disk, real `git`. */

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A temp directory holding `files`, removed after the test. */
export function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "hc-test-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  return dir;
}

export function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

export function read(repo: string, path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(repo: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV, input }).trim();
}

/** `git init` with everything in the working tree committed to `main`. */
export function gitInit(repo: string): void {
  git(repo, ["init", "-q", "-b", "main"]);
  // hc itself commits (migrate, import), and runs without GIT_ENV: an identity
  // in the repo is what lets it do so on a CI machine that has none globally.
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "cards"]);
}

/**
 * An orphan `hashcards-data` commit holding `reviews/<name>` files, made with
 * plumbing so the working tree and `main` are never touched — the way the app
 * writes it through the Git Data API. `ref` lets a test make only the
 * remote-tracking branch, as a fresh clone has.
 */
export function makeDataBranch(
  repo: string,
  reviews: Record<string, string>,
  ref = "refs/heads/hashcards-data"
): void {
  const entries = Object.entries(reviews)
    .map(([name, text]) => `100644 blob ${git(repo, ["hash-object", "-w", "--stdin"], text)}\t${name}`)
    .join("\n");
  const reviewsTree = git(repo, ["mktree"], entries + "\n");
  const root = git(repo, ["mktree"], `040000 tree ${reviewsTree}\treviews\n`);
  const commit = git(repo, ["commit-tree", root, "-m", "reviews"]);
  git(repo, ["update-ref", ref, commit]);
}

/** One v2 review line. */
export function review(card: string, at: string, grade: 1 | 2 | 3 | 4, tz = 120): string {
  return JSON.stringify({ v: 2, card, at, tz, grade, ms: 3000 });
}

export type Run = { code: number; stdout: string; stderr: string; json: () => any };

/** `hc …` in-process, with output captured. */
export async function hc(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; now?: string } = {}
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    cwd: opts.cwd ?? process.cwd(),
    // Never the real environment: CLAUDECODE there would turn every add into a draft.
    env: opts.env ?? {},
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdin: async () => opts.stdin ?? "",
    now: () => new Date(opts.now ?? "2026-10-15T10:00:00Z"),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
