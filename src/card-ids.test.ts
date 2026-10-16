import { describe, it, expect } from "vitest";
import { hasIds, stripIds } from "./card-ids";
import { parseFile } from "./parser";

/** Shaped like a deck from an early 1.0 build: an ID on every block. */
const DECK = `---
name = "Europe: Nordic & Baltic"
---

ID: k8q2xv7m
Q: Which country is highlighted?

![a highlighted country](map-nor.png)

A: **Norway**

---

ID: est-capital
Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn
Extra: ID: in an extra is text.

---

Tags: capitals
C: The capital of [Norway] is [Oslo].

---

Reverse: yes
ID: swe
Q: **Sweden**
A: ID: an answer can say this
`;

async function cards(text: string) {
  return (await parseFile(text, "t.md", "t")).map((c) => [c.key, c.content, c.tags, c.status]);
}

describe("stripping IDs", () => {
  it("takes out every block's ID line and nothing else", () => {
    expect(stripIds(DECK)).toBe(`---
name = "Europe: Nordic & Baltic"
---

Q: Which country is highlighted?

![a highlighted country](map-nor.png)

A: **Norway**

---

Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn
Extra: ID: in an extra is text.

---

Tags: capitals
C: The capital of [Norway] is [Oslo].

---

Reverse: yes
Q: **Sweden**
A: ID: an answer can say this
`);
  });

  it("leaves every card the same card", async () => {
    expect(await cards(stripIds(DECK))).toEqual(await cards(DECK));
  });

  it("knows the key each ID gave its card, until it is stripped", async () => {
    const before = await parseFile(DECK, "t.md", "t");
    expect(before.map((c) => c.legacyKey)).toEqual(["k8q2xv7m", "est-capital", null, null, "swe", "swe:r"]);
    const after = await parseFile(stripIds(DECK), "t.md", "t");
    expect(after.every((c) => c.legacyKey === null)).toBe(true);
  });

  it("keeps CRLF line endings and a missing trailing newline", () => {
    const crlf = "ID: a1\r\nQ: q\r\nA: a\r\n---\r\nID: b2\r\nC: [x]";
    expect(stripIds(crlf)).toBe("Q: q\r\nA: a\r\n---\r\nC: [x]");
  });

  it("is idempotent, and a no-op on a file without IDs", () => {
    const once = stripIds(DECK);
    expect(stripIds(once)).toBe(once);
    expect(hasIds(DECK)).toBe(true);
    expect(hasIds(once)).toBe(false);
  });

  it("throws on a file the parser cannot read", () => {
    expect(() => stripIds("A: no question", "bad.md")).toThrow(/bad\.md/);
  });
});
