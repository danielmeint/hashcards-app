import { cpSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatKey } from "../../src/card-key";
import { parseFile } from "../../src/parser";
import { git, gitInit, hc, makeDataBranch, makeRepo, read, review, write } from "../test-helpers";

/**
 * `hc migrate` on real git repos built from a copy of my-hashcards
 * (`cli/fixtures/v1-repo`): what it commits, what it refuses, and that
 * `hc due` and `hc stats` see the same collection on either side of it.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/v1-repo", import.meta.url));
const NOW = "2026-10-15T10:00:00Z";

function v1Repo(): string {
  const repo = makeRepo();
  cpSync(FIXTURE, repo, { recursive: true });
  gitInit(repo);
  return repo;
}

const head = (repo: string) => git(repo, ["rev-parse", "HEAD"]);
const refs = (repo: string) => git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
const run = (repo: string, ...args: string[]) => hc(["migrate", "--repo", repo, ...args], { now: NOW });

/** `hc due --json` reviews, keyed by the card's v1 hash key, so before and after line up. */
async function dueByHash(repo: string, date = "2026-10-15") {
  const out = (await hc(["due", "--json", "--repo", repo, "--date", date, "--limit", "1000"], { now: NOW })).json();
  const hashKeyOf = new Map<string, string>();
  for (const file of new Set<string>(out.reviews.cards.map((r: { file: string }) => r.file))) {
    for (const card of await parseFile(read(repo, file), file, "x")) {
      hashKeyOf.set(card.key, formatKey({ kind: "hash", hash: card.hash }));
    }
  }
  return new Map<string, string>(
    out.reviews.cards.map((r: { key: string; due: string }) => [hashKeyOf.get(r.key)!, r.due])
  );
}

describe("hc migrate", () => {
  it("is a dry run by default: shows the plan, changes nothing", async () => {
    const repo = v1Repo();
    const before = refs(repo);

    const result = await run(repo, "--json");

    expect(result.code).toBe(0);
    const out = result.json();
    expect(out.applied).toBe(false);
    expect(out.blockers).toEqual([]);
    expect(out.counts).toMatchObject({ cards: 240, baselines: 51, reviews: 58, unknownHashes: 87 });
    expect(out.check).toMatchObject({ other: 0, newer: 0 });
    expect(out.dataFiles).toEqual([
      "reviews/2026-03.v1.jsonl",
      "reviews/2026-04.v1.jsonl",
      "reviews/2026-06.v1.jsonl",
      "reviews/2026-08.v1.jsonl",
      "reviews/2026-10.v1.jsonl",
    ]);
    expect(refs(repo)).toBe(before);
    expect(git(repo, ["status", "--porcelain"])).toBe("");

    const text = await run(repo);
    expect(text.stdout).toContain("dry run, nothing written");
    expect(text.stdout).toContain("87 hashes no deck has, kept under h: keys");
    expect(text.stdout).toContain("No blockers.");
  });

  it("commits once on main and once on a new orphan hashcards-data, and pushes nothing", async () => {
    const repo = v1Repo();
    const old = head(repo);

    const result = await run(repo, "--apply");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("git push --atomic origin main hashcards-data");
    // main: one commit on top, the working tree moved with it.
    expect(git(repo, ["rev-parse", "HEAD^"])).toBe(old);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    const changed = git(repo, ["diff", "--name-status", old, "HEAD"]).split("\n").sort();
    expect(changed).toEqual(
      [
        "A\thashcards.toml",
        "D\thashcards-reviews/2026-10.3e2bd77f.jsonl",
        "D\thashcards-reviews/2026-10.5a1b5635.jsonl",
        "D\thashcards-state.json",
        "M\tgeography/europe/Europe_Central.md",
        "M\tgeography/europe/Europe_Nordic_Baltic.md",
        "M\tgeography/europe/Europe_Southern.md",
        "M\tgeography/europe/Europe_Western.md",
        "M\tgeography/germany/Germany_States.md",
        "M\tgeography/norway/Norway_Counties.md",
      ].sort()
    );
    // Stamping only ever adds ID lines.
    const diff = git(repo, ["diff", "-U0", old, "HEAD", "--", "geography"]);
    const edits = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l));
    expect(edits.every((l) => /^\+ID: [0-9a-z]{8}$/.test(l))).toBe(true);
    // The data branch: an orphan holding only the migrated files.
    expect(git(repo, ["rev-list", "--count", "hashcards-data"])).toBe("1");
    expect(git(repo, ["ls-tree", "-r", "--name-only", "hashcards-data"]).split("\n")).toHaveLength(5);
    expect(git(repo, ["remote"])).toBe("");

    const lint = await hc(["lint", "--json", "--repo", repo]);
    expect(lint.json()).toMatchObject({ ok: true, cards: 240, errors: [], warnings: [] });
    const toml = read(repo, "hashcards.toml");
    expect(toml).toContain("desired_retention = 0.9");
    expect(toml).toContain('"CARD_GUIDE.md"');
  });

  it("leaves hc due and hc stats seeing the same cards, schedules within fuzz", async () => {
    const repo = v1Repo();
    const dueBefore = await dueByHash(repo);
    const tomorrowBefore = await dueByHash(repo, "2026-10-16");
    const statsBefore = (await hc(["stats", "--json", "--repo", repo], { now: NOW })).json();

    await run(repo, "--apply");

    expect(await dueByHash(repo)).toEqual(dueBefore);
    expect(await dueByHash(repo, "2026-10-16")).toEqual(tomorrowBefore);
    expect(dueBefore.size).toBeGreaterThan(0);
    const statsAfter = (await hc(["stats", "--json", "--repo", repo], { now: NOW })).json();
    expect(statsAfter.history).not.toEqual(statsBefore.history);
    for (const key of ["cards", "retention", "reviews"]) expect(statsAfter[key]).toEqual(statsBefore[key]);
  });

  it("gives a re-added archived deck its history back", async () => {
    const repo = v1Repo();
    await run(repo, "--apply");
    renameSync(join(repo, "misc/Terraform_State.md.archived"), join(repo, "misc/Terraform_State.md"));

    const out = (await hc(["due", "--json", "--repo", repo, "--date", "2028-01-01", "--limit", "1000"], { now: NOW })).json();
    const terraform = out.reviews.cards.filter((r: { file: string }) => r.file === "misc/Terraform_State.md");
    expect(terraform).toHaveLength(7);
    expect(terraform.every((r: { key: string }) => r.key.startsWith("h:"))).toBe(true);
  });

  it("refuses to run twice", async () => {
    const repo = v1Repo();
    await run(repo, "--apply");
    const after = refs(repo);

    const again = await run(repo, "--apply");

    expect(again.code).toBe(2);
    expect(again.stderr).toContain("already migrated");
    expect(refs(repo)).toBe(after);
  });

  it("refuses a dirty working tree, untracked files included", async () => {
    for (const dirty of [
      (repo: string) => write(repo, "geography/europe/Europe_Central.md", "Q: changed\nA: a\n"),
      (repo: string) => write(repo, "notes.txt", "scratch"),
    ]) {
      const repo = v1Repo();
      dirty(repo);
      const before = refs(repo);

      const dry = await run(repo);
      expect(dry.code).toBe(1);
      expect(dry.stdout).toContain("the working tree has changes");

      const applied = await run(repo, "--apply");
      expect(applied.code).toBe(2);
      expect(refs(repo)).toBe(before);
    }
  });

  it("refuses an existing hashcards-data branch unless --force, local or remote", async () => {
    const repo = v1Repo();
    makeDataBranch(repo, { "2026-10.abcd1234.jsonl": review("x1", "2026-10-01T08:00:00.000Z", 3) + "\n" });
    const before = refs(repo);

    const refused = await run(repo, "--apply");
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain("hashcards-data already exists");
    expect(refs(repo)).toBe(before);

    const forced = await run(repo, "--apply", "--force");
    expect(forced.code).toBe(0);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "hashcards-data"])).not.toContain("abcd1234");

    const clone = v1Repo();
    makeDataBranch(clone, { "2026-10.abcd1234.jsonl": "" }, "refs/remotes/origin/hashcards-data");
    const remote = await run(clone, "--json");
    expect(remote.code).toBe(1);
    expect(remote.json().blockers[0]).toContain("origin/hashcards-data already exists");
  });

  it("refuses a repo with nothing of v1 in it", async () => {
    const v2 = makeRepo({ "deck.md": "ID: one\nQ: q\nA: a\n" });
    gitInit(v2);
    makeDataBranch(v2, { "2026-10.abcd1234.jsonl": review("one", "2026-10-01T08:00:00.000Z", 3) + "\n" });
    expect((await run(v2)).stderr).toContain("already migrated");

    const fresh = makeRepo({ "deck.md": "Q: q\nA: a\n" });
    gitInit(fresh);
    const out = await run(fresh, "--apply");
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("nothing to migrate");

    const notGit = makeRepo({ "hashcards-state.json": "{}" });
    expect((await run(notGit)).stderr).toContain("not a git repository");
  });

  it("refuses decks that do not parse or share an ID", async () => {
    const repo = v1Repo();
    write(repo, "broken.md", "C: no deletions here\n");
    write(repo, "dup-a.md", "ID: same\nQ: a\nA: a\n");
    write(repo, "dup-b.md", "ID: same\nQ: b\nA: b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "more decks"]);

    const out = await run(repo, "--json");
    expect(out.code).toBe(1);
    const blockers: string[] = out.json().blockers;
    expect(blockers.some((b) => b.startsWith("broken.md"))).toBe(true);
    expect(blockers.some((b) => b.includes("duplicate ID 'same'"))).toBe(true);
  });

  it("refuses a detached HEAD", async () => {
    const repo = v1Repo();
    git(repo, ["checkout", "-q", "--detach"]);
    const out = await run(repo, "--json");
    expect(out.code).toBe(1);
    expect(out.json().blockers[0]).toContain("detached");
  });

  it("keeps a hashcards.toml the repo already has", async () => {
    const repo = v1Repo();
    write(repo, "hashcards.toml", "[review]\nnew_per_day = 5\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "settings"]);

    const out = await run(repo, "--apply");

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("hashcards.toml exists and is kept");
    expect(read(repo, "hashcards.toml")).toBe("[review]\nnew_per_day = 5\n");
  });

  it("migrates a repo with a state file and no log", async () => {
    const repo = v1Repo();
    rmSync(join(repo, "hashcards-reviews"), { recursive: true });
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "no log"]);

    const out = await run(repo, "--apply", "--json");

    expect(out.code).toBe(0);
    expect(out.json().counts).toMatchObject({ baselines: 51, reviews: 0 });
    expect(out.json().check.other).toBe(0);
  });
});
