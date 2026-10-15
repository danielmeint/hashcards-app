import { describe, it, expect } from "vitest";
import { randomId, stampIds } from "./card-ids";
import { isValidId } from "./card-key";
import { parseFile } from "./parser";

/** A generator that hands out `id-1`, `id-2`, … — or whatever it is given. */
function sequence(ids?: string[]): () => string {
  let n = 0;
  return () => (ids ? ids[n++] : `id-${++n}`);
}

/**
 * The stamped text with every line the stamp added taken out again. Equal to
 * the original exactly when nothing else was touched.
 */
function unstamp(stamped: string, original: string): string {
  const before = new Set(original.split("\n"));
  return stamped
    .split("\n")
    .filter((line) => before.has(line) || !/^(ID: |---\r?$)/.test(line))
    .join("\n");
}

async function hashes(text: string): Promise<string[]> {
  return (await parseFile(text, "t.md", "t")).map((c) => c.hash);
}

/** Shaped like the real decks: frontmatter, `---` between blocks, blank lines. */
const DECK = `---
name = "Europe: Nordic & Baltic"
---

Q: Which country is highlighted?

![a highlighted country](map-nor.png)

A: **Norway**

---

ID: est-capital
Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn

---

Tags: capitals
C: The capital of [Norway] is [Oslo].

---

Reverse: yes
Q: **Sweden**
A: ![Sweden on the map](map-swe.png)
`;

describe("stamping IDs", () => {
  it("adds an ID line to the top of every block without one", () => {
    expect(stampIds(DECK, sequence())).toBe(`---
name = "Europe: Nordic & Baltic"
---

ID: id-1
Q: Which country is highlighted?

![a highlighted country](map-nor.png)

A: **Norway**

---

ID: est-capital
Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn

---

ID: id-2
Tags: capitals
C: The capital of [Norway] is [Oslo].

---

ID: id-3
Reverse: yes
Q: **Sweden**
A: ![Sweden on the map](map-swe.png)
`);
  });

  it("gives every stamped card the ID it was stamped with", async () => {
    const cards = await parseFile(stampIds(DECK, sequence()), "t.md", "t");
    expect(cards.map((c) => c.key)).toEqual([
      "id-1",
      "est-capital",
      "id-2:1",
      "id-2:2",
      "id-3",
      "id-3:r",
    ]);
  });

  it("changes no card's hash", async () => {
    expect(await hashes(stampIds(DECK))).toEqual(await hashes(DECK));
  });

  it("keeps a card's Extra section, and puts no ID inside it", async () => {
    const text = "Q: a\nA: b\nExtra: a note\nover two lines\n---\nC: [c] d\nExtra: another\n";
    const stamped = stampIds(text, sequence());
    expect(unstamp(stamped, text)).toBe(text);
    const cards = await parseFile(stamped, "t.md", "t");
    expect(cards.map((c) => [c.key, c.content.extra])).toEqual([
      ["id-1", "a note\nover two lines"],
      ["id-2:1", "another"],
    ]);
  });

  it("is idempotent", () => {
    const once = stampIds(DECK);
    expect(stampIds(once)).toBe(once);
  });

  it("leaves a file whose cards all have IDs byte for byte alone", () => {
    const done = "ID: ab\nQ: a\nA: b\n---\nID: cd\nC: [x] y";
    expect(stampIds(done, () => { throw new Error("not needed"); })).toBe(done);
  });

  it("never reuses an ID the file already has", async () => {
    const text = "ID: id-1\nQ: a\nA: b\n---\nQ: c\nA: d\n---\nQ: e\nA: f";
    const stamped = stampIds(text, sequence(["id-1", "id-1", "id-2", "id-2", "id-3"]));
    const cards = await parseFile(stamped, "t.md", "t");
    expect(cards.map((c) => c.id)).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("refuses a generator that only collides, rather than looping", () => {
    expect(() => stampIds("ID: ab\nQ: a\nA: b\n---\nQ: c\nA: d", () => "ab")).toThrow(
      /unused card ID/
    );
  });

  it("refuses a generator that produces invalid IDs", () => {
    expect(() => stampIds("Q: a\nA: b", () => "Not:Valid")).toThrow(/invalid card ID/);
  });

  it("touches nothing but the lines it adds", () => {
    const stamped = stampIds(DECK);
    expect(unstamp(stamped, DECK)).toBe(DECK);
    expect(stamped.split("\n").length - DECK.split("\n").length).toBe(3);
  });

  it("keeps CRLF line endings, on the lines it adds too", async () => {
    const crlf = DECK.replace(/\n/g, "\r\n");
    const stamped = stampIds(crlf, sequence());
    expect(stamped).toBe(stampIds(DECK, sequence()).replace(/\n/g, "\r\n"));
    expect(stamped).not.toMatch(/[^\r]\n/);
    expect(await hashes(stamped)).toEqual(await hashes(crlf));
  });

  it("keeps a missing trailing newline missing", () => {
    expect(stampIds("Q: a\nA: b", sequence())).toBe("ID: id-1\nQ: a\nA: b");
  });

  it("keeps a file that ends in blank lines as it was", () => {
    expect(stampIds("Q: a\nA: b\n\n\n", sequence())).toBe("ID: id-1\nQ: a\nA: b\n\n\n");
  });

  it("separates a card begun with no separator, so its ID is not the last answer", async () => {
    // Without `---`, the ID line would be part of "b"'s answer.
    const text = "Q: a\nA: b\n\nQ: c\nA: d\nC: [e] f\n";
    const stamped = stampIds(text, sequence());
    expect(stamped).toBe(
      "ID: id-1\nQ: a\nA: b\n\n---\nID: id-2\nQ: c\nA: d\n---\nID: id-3\nC: [e] f\n"
    );
    const cards = await parseFile(stamped, "t.md", "t");
    expect(cards.map((c) => c.id)).toEqual(["id-1", "id-2", "id-3"]);
    expect(await hashes(stamped)).toEqual(await hashes(text));
    expect(unstamp(stamped, text)).toBe(text);
  });

  it("stamps both copies of a duplicated card", () => {
    // Deduplicated by hash when parsed, but both blocks are in the file.
    expect(stampIds("Q: a\nA: b\n---\nQ: a\nA: b", sequence())).toBe(
      "ID: id-1\nQ: a\nA: b\n---\nID: id-2\nQ: a\nA: b"
    );
  });

  it("leaves an empty file empty", () => {
    expect(stampIds("")).toBe("");
    expect(stampIds("---\nname = \"x\"\n---\n")).toBe("---\nname = \"x\"\n---\n");
  });

  it("throws on a file the parser cannot read", () => {
    expect(() => stampIds("Q: no answer", sequence(), "broken.md")).toThrow(/broken\.md:1/);
  });
});

describe("random IDs", () => {
  it("are eight characters of lowercase Crockford base32", () => {
    for (let i = 0; i < 200; i++) {
      const id = randomId();
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
      expect(isValidId(id)).toBe(true);
    }
  });

  it("do not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, randomId));
    expect(ids.size).toBe(1000);
  });
});
