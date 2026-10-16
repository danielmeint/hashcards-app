import { describe, expect, it } from "vitest";
import { hc, makeRepo } from "../test-helpers";

const deck = (body: string) => `---\nname = "Deck"\n---\n\n${body}\n`;

describe("hc lint", () => {
  it("passes a clean collection and skips documentation files", async () => {
    const repo = makeRepo({
      "a.md": deck("Q: q1\nA: a1"),
      "sub/b.md": "C: a [cloze]\n",
      "README.md": "# Not a deck\nQ: stray\n",
      "CARD_GUIDE.md": "A: not a deck either\n",
      ".github/x.md": "A: hidden\n",
    });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    expect(run.json()).toEqual({ ok: true, files: 2, cards: 2, errors: [], warnings: [] });
  });

  it("reports parse errors with file and line, and exits 1", async () => {
    const repo = makeRepo({
      "a.md": deck("Q: q1\nA: a1\n\n---\n\nA: no question"),
      "b.md": "Q: fine\nA: fine\n---\nC: no deletions here\n",
    });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(1);
    expect(run.json().errors).toEqual([
      { kind: "parse", severity: "error", file: "a.md", line: 10, message: "Found answer tag without a question." },
      {
        kind: "parse",
        severity: "error",
        file: "b.md",
        line: 4,
        message: "Cloze card must contain at least one cloze deletion.",
      },
    ]);
    const human = await hc(["lint", "--repo", repo]);
    expect(human.stdout).toContain("a.md:10: error: Found answer tag without a question.");
  });

  it("warns about the same card twice, in one file or two, whitespace aside", async () => {
    const repo = makeRepo({
      "a.md": "Q: one\nA: 1\n---\nQ: other\nA: x\n---\nQ:  one\nA: 1 \n",
      "b.md": "Q: 0\nA: 0\n---\nQ: one\nA:\n1\n",
    });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    expect(run.json().warnings).toEqual([
      expect.objectContaining({ kind: "duplicate-card", file: "a.md", line: 7, message: expect.stringContaining("a.md:1") }),
      expect.objectContaining({ kind: "duplicate-card", file: "b.md", line: 4, message: expect.stringContaining("a.md:1") }),
    ]);
    // One card, counted once.
    expect(run.json().cards).toBe(3);
    expect((await hc(["lint", "--strict", "--repo", repo])).code).toBe(1);
  });

  it("warns about ID: lines left from early 1.0 builds, once per file", async () => {
    const repo = makeRepo({ "a.md": deck("ID: one\nQ: q1\nA: a1\n---\nC: [x]\n---\nID: two\nQ: q2\nA: a2") });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    expect(run.json().warnings).toEqual([
      expect.objectContaining({ kind: "legacy-id", file: "a.md", line: 5, message: expect.stringContaining("hc migrate") }),
    ]);
  });

  it("has no --fix any more: there is nothing to stamp", async () => {
    const repo = makeRepo({ "a.md": "Q: q\nA: a\n" });
    expect((await hc(["lint", "--fix", "--repo", repo])).code).toBe(2);
  });

  it("emits GitHub annotations inside Actions", async () => {
    const repo = makeRepo({ "a.md": "A: x\n" });
    const run = await hc(["lint", "--repo", repo], { env: { GITHUB_ACTIONS: "true" } });
    expect(run.stdout).toContain("::error file=a.md,line=1::Found answer tag without a question.");
  });

  it("follows hashcards.toml [decks] include and exclude", async () => {
    const repo = makeRepo({
      "hashcards.toml": '[decks]\ninclude = ["cards/**/*.md"]\nexclude = ["cards/archive/**"]\n',
      "cards/a.md": "Q: 1\nA: 1\n",
      "cards/archive/old.md": "A: broken\n",
      "notes.md": "A: broken\n",
    });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.json()).toMatchObject({ ok: true, files: 1 });
  });

  it("reports a broken hashcards.toml", async () => {
    const repo = makeRepo({ "hashcards.toml": "[review]\nnew_per_day = lots\n" });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(1);
    expect(run.json().errors[0]).toMatchObject({ kind: "config", file: "hashcards.toml", line: 2 });
  });
});
