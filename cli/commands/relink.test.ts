import { describe, expect, it } from "vitest";
import { parseFile } from "../../src/parser";
import { git, gitInit, hc, makeDataBranch, makeRepo, review, write } from "../test-helpers";

/**
 * `hc relink` (PLAN-1.0 §2.7): history carried over an edit made outside the
 * app, on request, as `link` events on the data branch.
 */

const NOW = "2026-10-16T10:00:00Z";
const DECK = "Q: Capital of Estonia?\nA: Tallinn\n\n---\n\nC: The [Danube] flows into the [Black Sea].\n\n---\n\nQ: untouched\nA: u\n";

const keys = async (text: string) => (await parseFile(text, "deck.md", "deck")).map((c) => c.key);

async function repoWithHistory() {
  const repo = makeRepo({ "deck.md": DECK });
  gitInit(repo);
  const [est, danube, sea, untouched] = await keys(DECK);
  makeDataBranch(repo, {
    "2026-10.dev1.jsonl": [
      review(est, "2026-10-01T08:00:00.000Z", 3),
      review(est, "2026-10-04T08:00:00.000Z", 3),
      review(danube, "2026-10-02T08:00:00.000Z", 3),
      review(sea, "2026-10-02T08:00:00.000Z", 1),
      review(untouched, "2026-10-02T08:00:00.000Z", 3),
    ].join("\n") + "\n",
  });
  return { repo, est, danube, sea, untouched };
}

const run = (repo: string, ...args: string[]) => hc(["relink", "--repo", repo, ...args], { now: NOW });
const reviewCount = async (repo: string, key: string) =>
  (await hc(["show", key, "--json", "--repo", repo], { now: NOW })).json().cards[0]?.state?.reviewCount ?? 0;

describe("hc relink", () => {
  it("pairs edited cards with what they became, and links them with --apply", async () => {
    const { repo, est, danube, sea } = await repoWithHistory();
    const edited = DECK.replace("A: Tallinn", "A: **Tallinn**").replace("flows into", "empties into");
    write(repo, "deck.md", edited);
    const [newEst, newDanube, newSea] = await keys(edited);

    const dry = await run(repo, "--json");
    expect(dry.code).toBe(1);
    expect(dry.json()).toMatchObject({ applied: false, compared: expect.stringContaining("HEAD"), unpaired: [] });
    expect(dry.json().links.map((l: { from: string; to: string }) => [l.from, l.to])).toEqual([
      [est, newEst],
      [danube, newDanube],
      [sea, newSea],
    ]);
    expect(await reviewCount(repo, newEst)).toBe(0);

    const applied = await run(repo, "--apply");
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("git push origin hashcards-data");
    expect(await reviewCount(repo, newEst)).toBe(2);
    expect(await reviewCount(repo, newSea)).toBe(1);
    const file = git(repo, ["show", "hashcards-data:reviews/2026-10.hc.jsonl"]);
    expect(file.split("\n").map((l) => JSON.parse(l).src)).toEqual(["relink", "relink", "relink"]);

    // Done: nothing left to link.
    expect((await run(repo, "--json")).json().links).toEqual([]);
  });

  it("compares with the last commit when the edit is already committed", async () => {
    const { repo, est } = await repoWithHistory();
    write(repo, "deck.md", DECK.replace("A: Tallinn", "A: Tallinn (Reval)"));
    git(repo, ["commit", "-qam", "edit on GitHub"]);
    const out = (await run(repo, "--json")).json();
    expect(out.compared).toContain("HEAD^");
    expect(out.links.map((l: { from: string }) => l.from)).toEqual([est]);
  });

  it("does not take a moved card, or a new one, for an edit", async () => {
    const { repo } = await repoWithHistory();
    write(repo, "deck.md", "Q: brand new\nA: n\n\n---\n\n" + DECK.split("\n---\n").slice(1).join("\n---\n"));
    write(repo, "other.md", "Q: Capital of Estonia?\nA: Tallinn\n");
    const out = (await run(repo, "--json")).json();
    expect(out.links).toEqual([]);
  });

  it("lists what it cannot pair, and links a pair by name", async () => {
    const { repo, est } = await repoWithHistory();
    // One card became two: which one inherits is a person's call.
    write(repo, "deck.md", DECK.replace("Q: Capital of Estonia?\nA: Tallinn", "Q: Estonia's capital?\nA: Tallinn\n\n---\n\nQ: Tallinn is the capital of?\nA: Estonia"));
    const dry = (await run(repo, "--json")).json();
    expect(dry.links).toEqual([]);
    expect(dry.unpaired).toEqual([expect.stringContaining(est)]);

    const byName = await run(repo, est, "deck.md:1", "--apply", "--json");
    expect(byName.code).toBe(0);
    const [target] = await keys("Q: Estonia's capital?\nA: Tallinn\n");
    expect(byName.json().links).toEqual([{ from: est, to: target, file: "deck.md", line: 1 }]);
    expect(await reviewCount(repo, target)).toBe(2);
  });

  it("refuses to link from a card still in the decks, or one with no history", async () => {
    const { repo, untouched } = await repoWithHistory();
    expect((await run(repo, untouched, "deck.md:1")).code).toBe(2);
    expect((await run(repo, "h:0000000000000000", "deck.md:1")).code).toBe(2);
    expect((await run(repo, "only-one")).code).toBe(2);
  });
});
