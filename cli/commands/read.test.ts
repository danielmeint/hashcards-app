import { describe, expect, it } from "vitest";
import { replay } from "../../src/core/replay";
import { parseFile as parseLog } from "../../src/core/events";
import { hashBasicCard } from "../../src/hash";
import { parseFile } from "../../src/parser";
import { git, gitInit, hc, makeDataBranch, makeRepo, review, write } from "../test-helpers";

/**
 * `due`, `stats`, `leeches` and `show` over real git repos: a v2 one with a
 * `hashcards-data` branch, and a v1 one with the state file and old log.
 */

const DECK = `---
name = "Fixture"
---

Q: Capital of Estonia?
A: Tallinn

---

C: The [hard] one.

---

Q: new a
A: a

---

Q: new b
A: b

---

Status: draft
Q: draft
A: d

---

Status: suspended
Q: s
A: s
`;

/** Each card's key (PLAN-1.0 §2.7), by a name for it. */
const [EST, LEECHY, FRESH_A, , , SUSP] = (await parseFile(DECK, "deck.md", "deck")).map((c) => c.key);

const LOG = [
  review(EST, "2026-10-01T08:00:00.000Z", 3),
  review(LEECHY, "2026-10-05T08:00:00.000Z", 1),
  review(LEECHY, "2026-10-07T08:00:00.000Z", 1),
  review(LEECHY, "2026-10-09T08:00:00.000Z", 1),
  review(LEECHY, "2026-10-10T08:00:00.000Z", 3),
  review(SUSP, "2026-10-01T08:00:00.000Z", 1),
  review("gone-card", "2026-10-02T08:00:00.000Z", 1),
  review("gone-card", "2026-10-03T08:00:00.000Z", 1),
  review("gone-card", "2026-10-04T08:00:00.000Z", 1),
].join("\n") + "\n";

function v2Repo(ref?: string) {
  const repo = makeRepo({ "deck.md": DECK, "hashcards.toml": "[review]\nnew_per_day = 1\n" });
  gitInit(repo);
  makeDataBranch(repo, { "2026-10.dev1.jsonl": LOG }, ref);
  return repo;
}

const expected = () => replay(parseLog(LOG).events, { retention: 0.9, fuzz: true });

describe("reading history from the hashcards-data branch", () => {
  it("hc due lists due reviews and budgeted new cards, never drafts or suspended", async () => {
    const repo = v2Repo();
    const run = await hc(["due", "--json", "--repo", repo, "--date", "2026-10-30"]);
    expect(run.code).toBe(0);
    const out = run.json();
    const states = expected();
    expect(out.date).toBe("2026-10-30");
    expect(out.history).toEqual({ kind: "data-branch", ref: "refs/heads/hashcards-data", files: 1 });
    expect(out.reviews.cards.map((c: { key: string }) => c.key).sort()).toEqual([EST, LEECHY].sort());
    const est = out.reviews.cards.find((c: { key: string }) => c.key === EST);
    expect(est).toMatchObject({ file: "deck.md", line: 5, deck: "Fixture", due: states.get(EST)!.dueDate });
    expect(out.new).toMatchObject({ count: 1, unseen: 2, perDay: 1, introducedToday: 0 });
    expect(out.new.cards[0]).toMatchObject({ key: FRESH_A, summary: "new a" });
    expect(out.drafts).toBe(1);
    const human = await hc(["due", "--repo", repo, "--date", "2026-10-30"]);
    expect(human.stdout).toMatch(/^2026-10-30: 2 reviews due, 1 new \(2 unseen; 0\/1 new started today\); 1 draft waiting in the Inbox$/m);
  });

  it("charges new cards started that day against the budget", async () => {
    const repo = makeRepo({ "deck.md": DECK, "hashcards.toml": "[review]\nnew_per_day = 2\n" });
    gitInit(repo);
    makeDataBranch(repo, { "2026-10.x.jsonl": review(FRESH_A, "2026-10-15T07:00:00.000Z", 3) + "\n" });
    const out = (await hc(["due", "--json", "--repo", repo, "--date", "2026-10-15"])).json();
    expect(out.new).toMatchObject({ introducedToday: 1, count: 1, perDay: 2, unseen: 3 });
  });

  it("reads the remote branch when the local one is only behind it", async () => {
    const repo = v2Repo();
    // Another device pushed since this clone last updated its local branch.
    git(repo, ["update-ref", "refs/remotes/origin/hashcards-data", "hashcards-data"]);
    makeDataBranch(repo, { "2026-10.dev1.jsonl": LOG, "2026-10.dev2.jsonl": review(FRESH_A, "2026-10-15T07:00:00.000Z", 3) + "\n" }, "refs/remotes/origin/hashcards-data");
    git(repo, ["update-ref", "refs/remotes/origin/hashcards-data",
      git(repo, ["commit-tree", "refs/remotes/origin/hashcards-data^{tree}", "-p", "hashcards-data", "-m", "newer"])]);
    const out = (await hc(["due", "--json", "--repo", repo, "--date", "2026-10-30"])).json();
    expect(out.history.ref).toBe("refs/remotes/origin/hashcards-data");
    expect(out.history.files).toBe(2);
  });

  it("reads the remote branch of a fresh clone", async () => {
    const repo = v2Repo("refs/remotes/origin/hashcards-data");
    const out = (await hc(["due", "--json", "--repo", repo, "--date", "2026-10-30"])).json();
    expect(out.history.ref).toBe("refs/remotes/origin/hashcards-data");
    expect(out.reviews.count).toBe(2);
  });

  it("hc stats counts cards, retention, forecast and reviews per day", async () => {
    const repo = v2Repo();
    const run = await hc(["stats", "--json", "--repo", repo, "--date", "2026-10-10", "--days", "3"]);
    expect(run.code).toBe(0);
    const out = run.json();
    expect(out.cards).toEqual({
      total: 6, active: 4, draft: 1, suspended: 1, new: 2, young: 2, mature: 0, decks: 1, files: 1,
    });
    // Learned-card reviews: leechy's 2nd, 3rd, 4th; gone-card's 2nd, 3rd. One passed.
    expect(out.retention.allTime).toEqual({ reviews: 5, passed: 1, rate: 0.2 });
    expect(out.retention.desired).toBe(0.9);
    expect(out.forecast).toHaveLength(14);
    expect(out.forecast[0].date).toBe("2026-10-10");
    expect(out.reviews.perDay).toEqual([
      { date: "2026-10-08", reviews: 0 },
      { date: "2026-10-09", reviews: 1 },
      { date: "2026-10-10", reviews: 1 },
    ]);
    expect(out.reviews).toMatchObject({ total: 9, streak: 2 });
    const human = await hc(["stats", "--repo", repo, "--date", "2026-10-10"]);
    expect(human.stdout).toContain("active     4  new 2 · young 2 · mature 0");
  });

  it("hc leeches finds cards with enough lapses, exiting 1", async () => {
    const repo = v2Repo();
    const run = await hc(["leeches", "--json", "--repo", repo]);
    expect(run.code).toBe(1);
    expect(run.json()).toEqual({
      minLapses: 3,
      leeches: [
        expect.objectContaining({ key: LEECHY, lapses: 3, reviews: 4, streak: 1, recovering: false, file: "deck.md", summary: "The […] one." }),
      ],
    });
    const all = (await hc(["leeches", "--json", "--all", "--repo", repo])).json();
    expect(all.leeches.map((l: { key: string }) => l.key)).toEqual(["gone-card", LEECHY].sort());
    expect((await hc(["leeches", "--min-lapses", "4", "--repo", repo])).code).toBe(0);
    expect((await hc(["leeches", "--min-lapses", "zero", "--repo", repo])).code).toBe(2);
  });

  it("hc show gives a card's text, place, state and history", async () => {
    const repo = v2Repo();
    const run = await hc(["show", "deck.md:10", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    const [card] = run.json().cards;
    expect(card).toMatchObject({
      key: LEECHY,
      file: "deck.md",
      range: [10, 10],
      type: "cloze",
      front: "The […] one.",
      back: "The [hard] one.",
      state: { dueDate: expected().get(LEECHY)!.dueDate, reviewCount: 4 },
    });
    expect(card.history).toHaveLength(4);
    // By key, or by the start of its hash, as well.
    expect((await hc(["show", LEECHY, "--json", "--repo", repo])).json().cards[0].key).toBe(LEECHY);
    expect((await hc(["show", LEECHY.slice(2, 10), "--json", "--repo", repo])).json().cards[0].key).toBe(LEECHY);

    const gone = (await hc(["show", "gone-card", "--json", "--repo", repo])).json();
    expect(gone.cards).toEqual([expect.objectContaining({ key: "gone-card", deleted: true, file: null })]);
    expect((await hc(["show", "nothing-here", "--repo", repo])).code).toBe(1);
    const human = await hc(["show", EST, "--repo", repo]);
    expect(human.stdout).toContain(`${EST}  deck.md:5-6`);
    expect(human.stdout).toMatch(/2026-10-01\s+good\s+3\.0s/);
  });

  it("works with no git at all: no history, every card new", async () => {
    const repo = makeRepo({ "deck.md": DECK });
    const out = (await hc(["due", "--json", "--repo", repo])).json();
    expect(out.history).toEqual({ kind: "none" });
    expect(out.reviews.count).toBe(0);
    expect(out.new).toMatchObject({ count: 4, unseen: 4 });
  });
});

describe("reading a v1 repo", () => {
  async function v1Repo() {
    const deck = "Q: Capital of Estonia?\nA: Tallinn\n---\nQ: Capital of Latvia?\nA: Riga\n";
    const hash = await hashBasicCard("Capital of Estonia?", "Tallinn");
    const orphan = "f".repeat(64);
    const state = {
      version: 1,
      cards: {
        [hash]: { lastReviewedAt: "2026-10-13T19:14:37.619Z", stability: 2.3, difficulty: 5, intervalRaw: 2.3, intervalDays: 2, dueDate: "2026-10-15", reviewCount: 1 },
        [orphan]: { lastReviewedAt: "2026-10-13T19:00:00.000Z", stability: 2.3, difficulty: 5, intervalRaw: 2.3, intervalDays: 2, dueDate: "2026-10-15", reviewCount: 1 },
      },
    };
    const line = JSON.stringify({ card: hash, at: "2026-10-13T19:14:37.619Z", grade: 1, s: 2.3, d: 5, ms: 1000 });
    const repo = makeRepo({
      "deck.md": deck,
      "hashcards-state.json": JSON.stringify(state),
      "hashcards-reviews/2026-10.abcd.jsonl": line + "\nnot json\n",
    });
    gitInit(repo);
    return { repo, key: (await parseFile(deck, "deck.md", "deck"))[0].key };
  }

  it("uses the state file as baselines and the old log as v1 reviews", async () => {
    const { repo, key } = await v1Repo();
    const out = (await hc(["due", "--json", "--repo", repo, "--date", "2026-10-15"])).json();
    expect(out.history).toEqual({ kind: "v1", stateFile: true, files: 1 });
    expect(out.reviews.cards).toEqual([expect.objectContaining({ key, due: "2026-10-15", file: "deck.md", line: 1 })]);
    expect(out.new).toMatchObject({ unseen: 1 });
    expect(out.warnings).toEqual(["hashcards-reviews/2026-10.abcd.jsonl:2: not valid JSON"]);

    const shown = (await hc(["show", key, "--json", "--repo", repo])).json().cards[0];
    // The baseline borrows the grade of the logged review it stands for.
    expect(shown.history.map((e: { kind: string; src: string; grade: number }) => [e.kind, e.src, e.grade])).toEqual([
      ["review", "v1", 1],
      ["baseline", "v1", 1],
    ]);
    expect((await hc(["show", "h:ffffffffffffffff", "--json", "--repo", repo])).json().cards[0]).toMatchObject({ deleted: true });
  });

  it("ignores v1 files once a data branch exists", async () => {
    const { repo } = await v1Repo();
    makeDataBranch(repo, { "2026-10.x.jsonl": "" });
    const out = (await hc(["stats", "--json", "--repo", repo])).json();
    expect(out.history.kind).toBe("data-branch");
    expect(out.reviews.total).toBe(0);
  });

  it("gives read commands the same shape on v1 and v2", async () => {
    const { repo: v1 } = await v1Repo();
    const v2 = v2Repo();
    for (const cmd of ["due", "stats", "leeches"]) {
      const a = (await hc([cmd, "--json", "--repo", v1])).json();
      const b = (await hc([cmd, "--json", "--repo", v2])).json();
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    }
  });
});

describe("history files beside drafts", () => {
  it("never lists a draft as due even with history", async () => {
    const repo = makeRepo({ "deck.md": "ID: dd\nStatus: draft\nQ: q\nA: a\n" });
    gitInit(repo);
    makeDataBranch(repo, { "a.jsonl": review("dd", "2026-10-01T08:00:00.000Z", 3) + "\n" });
    write(repo, "hashcards.toml", "");
    const out = (await hc(["due", "--json", "--repo", repo, "--date", "2027-01-01"])).json();
    expect(out.reviews.count).toBe(0);
    expect(out.new.count).toBe(0);
  });
});
