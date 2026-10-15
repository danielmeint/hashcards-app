import { describe, expect, it } from "vitest";
import { hc, makeRepo, read, write } from "../test-helpers";
import { loadCollection } from "../collection";
import { stampMissing } from "./lint";

const deck = (body: string) => `---\nname = "Deck"\n---\n\n${body}\n`;

describe("hc lint", () => {
  it("passes a clean collection and skips documentation files", async () => {
    const repo = makeRepo({
      "a.md": deck("ID: one\nQ: q1\nA: a1"),
      "sub/b.md": "ID: two\nC: a [cloze]\n",
      "README.md": "# Not a deck\nQ: stray\n",
      "CARD_GUIDE.md": "A: not a deck either\n",
      ".github/x.md": "A: hidden\n",
    });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    expect(run.json()).toEqual({ ok: true, files: 2, cards: 2, errors: [], warnings: [], fixed: [] });
  });

  it("reports parse errors with file and line, and exits 1", async () => {
    const repo = makeRepo({
      "a.md": deck("ID: one\nQ: q1\nA: a1\n\n---\n\nA: no question"),
      "b.md": "Q: fine\nA: fine\n---\nC: no deletions here\n",
    });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(1);
    expect(run.json().errors).toEqual([
      { kind: "parse", severity: "error", file: "a.md", line: 11, message: "Found answer tag without a question." },
      {
        kind: "parse",
        severity: "error",
        file: "b.md",
        line: 4,
        message: "Cloze card must contain at least one cloze deletion.",
      },
    ]);
    const human = await hc(["lint", "--repo", repo]);
    expect(human.stdout).toContain("a.md:11: error: Found answer tag without a question.");
  });

  it("reports an ID used in two files", async () => {
    const repo = makeRepo({ "a.md": "ID: same\nQ: 1\nA: 1\n", "b.md": "Q: 0\nA: 0\n---\nID: same\nQ: 2\nA: 2\n" });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(1);
    expect(run.json().errors).toEqual([
      expect.objectContaining({ kind: "duplicate-id", file: "b.md", line: 4, id: "same", message: expect.stringContaining("a.md:1") }),
    ]);
  });

  it("warns about missing IDs, failing only with --strict", async () => {
    const repo = makeRepo({ "a.md": deck("Q: q1\nA: a1\n---\nID: two\nC: [x]") });
    const run = await hc(["lint", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    expect(run.json().warnings).toEqual([expect.objectContaining({ kind: "missing-id", file: "a.md", line: 5 })]);
    expect((await hc(["lint", "--strict", "--repo", repo])).code).toBe(1);
  });

  it("emits GitHub annotations inside Actions", async () => {
    const repo = makeRepo({ "a.md": "A: x\n" });
    const run = await hc(["lint", "--repo", repo], { env: { GITHUB_ACTIONS: "true" } });
    expect(run.stdout).toContain("::error file=a.md,line=1::Found answer tag without a question.");
  });

  it("follows hashcards.toml [decks] include and exclude", async () => {
    const repo = makeRepo({
      "hashcards.toml": '[decks]\ninclude = ["cards/**/*.md"]\nexclude = ["cards/archive/**"]\n',
      "cards/a.md": "ID: aa\nQ: 1\nA: 1\n",
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

describe("hc lint --fix", () => {
  const original = {
    "a.md": deck("Q: q1\nA: a1\n\n---\n\nID: keep\nC: [x] and [y]\n\n---\n\nQ: q3\nA: a3\nQ: q4\nA: a4"),
    "b.md": "C: [b]\r\n---\r\nQ: crlf\r\nA: yes\r\n",
    "broken.md": "ID: owned\nQ: x\n",
  };

  it("stamps every missing ID, touches nothing else, and leaves broken files alone", async () => {
    const repo = makeRepo(original);
    const run = await hc(["lint", "--fix", "--json", "--repo", repo]);
    expect(run.json().fixed).toEqual([
      { file: "a.md", stamped: 3 },
      { file: "b.md", stamped: 2 },
    ]);
    expect(run.json().warnings).toEqual([]);
    expect(run.code).toBe(1); // broken.md still does not parse
    expect(read(repo, "broken.md")).toBe(original["broken.md"]);

    const a = read(repo, "a.md");
    // Removing the ID lines (and the separator stamping adds before an
    // implicit card) gives back the original byte for byte.
    expect(a.replace(/^ID: [0-9a-z]{8}\n/gm, "").replace("A: a3\n---\n", "A: a3\n")).toBe(original["a.md"]);
    expect(read(repo, "b.md")).toMatch(/^ID: [0-9a-z]{8}\r\nC: \[b\]\r\n---\r\nID: [0-9a-z]{8}\r\nQ: crlf/);
  });

  it("is idempotent", async () => {
    const repo = makeRepo(original);
    await hc(["lint", "--fix", "--repo", repo]);
    const once = { a: read(repo, "a.md"), b: read(repo, "b.md") };
    const again = await hc(["lint", "--fix", "--json", "--repo", repo]);
    expect(again.json().fixed).toEqual([]);
    expect({ a: read(repo, "a.md"), b: read(repo, "b.md") }).toEqual(once);
  });

  it("never stamps an ID taken anywhere in the collection, even in a broken file", async () => {
    const repo = makeRepo(original);
    write(repo, "c.md", "ID: in-c\nQ: 1\nA: 1\n");
    const collection = await loadCollection(repo);
    const offers = ["keep", "owned", "in-c", "fresh001", "fresh001", "fresh002", "fresh003", "fresh004", "fresh005"];
    const fixed = stampMissing(collection, () => offers.shift()!);
    expect(fixed.reduce((n, f) => n + f.stamped, 0)).toBe(5);
    const ids = (read(repo, "a.md") + read(repo, "b.md")).match(/^ID: (\S+)/gm)!.map((l) => l.slice(4).trim());
    expect(ids.sort()).toEqual(["fresh001", "fresh002", "fresh003", "fresh004", "fresh005", "keep"]);
  });
});
