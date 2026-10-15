import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECK, makeCollection } from "../anki/test-collection";
import { placement } from "./import-anki";
import { git, gitInit, hc, makeDataBranch, makeRepo, read, review, write } from "../test-helpers";

/**
 * `hc import anki` into real git repos, from the importer's synthetic
 * collection (WAL mode, unicase schema) and a one-deck ankictl repo.
 */

const NOW = "2026-10-30T10:00:00Z";
const DEVICE_FILE = { "2026-10.abcd1234.jsonl": review("own-card", "2026-10-01T08:00:00.000Z", 3) + "\n" };

/** The ankictl repo and a collection copy, in a temp dir. */
function sources(): { decks: string; collection: string } {
  const dir = makeRepo();
  makeCollection(join(dir, "collection.anki2"));
  mkdirSync(join(dir, "decks", "decks", "Cka"), { recursive: true });
  writeFileSync(join(dir, "decks", "ankictl.yaml"), "key_field: Key\n");
  writeFileSync(join(dir, "decks", "decks", "Cka", "Storage.yaml"), DECK);
  return { decks: join(dir, "decks"), collection: join(dir, "collection.anki2") };
}

/** A migrated card repo: IDs, hashcards.toml, a data branch with one device's file. */
function v2Repo(): string {
  const repo = makeRepo({
    "geo.md": "ID: own-card\nQ: q\nA: a\n",
    "hashcards.toml": '[decks]\ninclude = ["**/*.md"]\nexclude = ["README.md"]\n',
  });
  gitInit(repo);
  makeDataBranch(repo, DEVICE_FILE);
  return repo;
}

function importAnki(repo: string, src: { decks: string; collection: string }, ...args: string[]) {
  return hc(
    ["import", "anki", "--decks", src.decks, "--collection", src.collection, "--into", repo, "--acronym", "CKA", ...args],
    { now: NOW }
  );
}

const refs = (repo: string) => git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);

describe("hc import anki", () => {
  it("is a dry run by default, with the plan and the parity check", async () => {
    const repo = v2Repo();
    const before = refs(repo);

    const run = await importAnki(repo, sources(), "--json");

    expect(run.code).toBe(0);
    const out = run.json();
    expect(out).toMatchObject({
      applied: false,
      blockers: [],
      decks: ["cka/storage.md"],
      reviewFiles: ["reviews/2026-09.anki.jsonl", "reviews/2026-10.anki.jsonl"],
    });
    expect(out.summary.reviews).toMatchObject({ revlogRows: 11, imported: 5 });
    expect(out.parity.compared).toBeGreaterThan(0);
    expect(out.parityWithoutFuzz.compared).toBeGreaterThan(0);
    expect(refs(repo)).toBe(before);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("commits the decks on main and the reviews on top of hashcards-data", async () => {
    const repo = v2Repo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const tip = git(repo, ["rev-parse", "hashcards-data"]);

    const run = await importAnki(repo, sources(), "--apply");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("git push --atomic origin main hashcards-data");
    expect(git(repo, ["rev-parse", "HEAD^"])).toBe(head);
    expect(git(repo, ["diff", "--name-status", head, "HEAD"])).toBe("A\tcka/storage.md");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(repo, ["rev-parse", "hashcards-data^"])).toBe(tip);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "hashcards-data"]).split("\n")).toEqual([
      "reviews/2026-09.anki.jsonl",
      "reviews/2026-10.abcd1234.jsonl",
      "reviews/2026-10.anki.jsonl",
    ]);
    const october = git(repo, ["show", "hashcards-data:reviews/2026-10.anki.jsonl"]);
    expect(october.split("\n").map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ card: "pv-reclaim", src: "anki", tz: 60 })
    );

    expect((await hc(["lint", "--json", "--repo", repo])).json()).toMatchObject({ ok: true, errors: [] });
    const show = (await hc(["show", "pv-reclaim", "--json", "--repo", repo], { now: NOW })).json();
    expect(show.cards[0].state.reviewCount).toBe(3);
    expect(read(repo, "cka/storage.md")).toContain('name = "CKA: Storage"');
  });

  it("puts the decks under --dir", async () => {
    const run = await importAnki(v2Repo(), sources(), "--dir", "kubernetes", "--json");
    expect(run.json().decks).toEqual(["kubernetes/storage.md"]);
    expect(placement(["cka/a.md", "cka/b/c.md"], "k8s")("cka/b/c.md")).toBe("k8s/b/c.md");
    expect(placement(["cka/a.md", "geo/b.md"], "x")("geo/b.md")).toBe("x/geo/b.md");
    expect(placement(["cka/a.md"], ".")("cka/a.md")).toBe("a.md");
  });

  it("refuses a second import unless --force, which replaces the first", async () => {
    const repo = v2Repo();
    const src = sources();
    await importAnki(repo, src, "--apply");
    // The deck is there now: move it aside, as a person reorganising would.
    git(repo, ["mv", "cka/storage.md", "cka/storage-old.md"]);
    git(repo, ["commit", "-qm", "rename"]);
    git(repo, ["rm", "-q", "cka/storage-old.md"]);
    git(repo, ["commit", "-qm", "drop"]);
    const before = git(repo, ["show", "hashcards-data:reviews/2026-10.anki.jsonl"]);

    const again = await importAnki(repo, src, "--apply");
    expect(again.code).toBe(2);
    expect(again.stdout).toContain("already has 2 Anki review files");

    const forced = await importAnki(repo, src, "--apply", "--force");
    expect(forced.code).toBe(0);
    expect(git(repo, ["show", "hashcards-data:reviews/2026-10.anki.jsonl"])).toBe(before);
  });

  it("refuses a repo that is not migrated, a dirty one, and IDs or files it already has", async () => {
    const src = sources();
    const v1 = makeRepo({ "a.md": "Q: q\nA: a\n", "hashcards-state.json": "{}" });
    gitInit(v1);
    expect((await importAnki(v1, src, "--json")).json().blockers).toContainEqual(expect.stringContaining("hc migrate"));

    const dirty = v2Repo();
    write(dirty, "scratch.txt", "x");
    expect((await importAnki(dirty, src, "--apply")).code).toBe(2);

    const clash = v2Repo();
    write(clash, "other.md", "ID: pv-reclaim\nQ: mine\nA: mine\n");
    write(clash, "cka/storage.md", "ID: unrelated\nQ: q\nA: a\n");
    git(clash, ["add", "-A"]);
    git(clash, ["commit", "-qm", "clash"]);
    const blockers: string[] = (await importAnki(clash, src, "--json")).json().blockers;
    expect(blockers).toContainEqual(expect.stringContaining("cka/storage.md already exists"));
    expect(blockers).toContainEqual(expect.stringContaining("already in the repo: pv-reclaim"));
  });

  it("never reads a collection inside Anki's profile directory", async () => {
    const src = sources();
    const live = join(makeRepo(), "Anki2", "User 1");
    mkdirSync(live, { recursive: true });
    copyFileSync(src.collection, join(live, "collection.anki2"));

    const run = await importAnki(v2Repo(), { ...src, collection: join(live, "collection.anki2") });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("inside Anki's profile directory");
  });

  it("builds on the remote's data branch when there is no local one", async () => {
    const repo = makeRepo({ "geo.md": "ID: own-card\nQ: q\nA: a\n" });
    gitInit(repo);
    makeDataBranch(repo, DEVICE_FILE, "refs/remotes/origin/hashcards-data");
    const remote = git(repo, ["rev-parse", "origin/hashcards-data"]);

    expect((await importAnki(repo, sources(), "--apply")).code).toBe(0);

    expect(git(repo, ["rev-parse", "hashcards-data^"])).toBe(remote);
  });

  it("takes only anki as a source", async () => {
    const run = await hc(["import", "mnemosyne", "--repo", makeRepo()]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("can only import from anki");
  });
});
