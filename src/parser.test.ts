import { describe, it, expect } from "vitest";
import { parseFile } from "./parser";
import { basicIdentity, hashBasicCard } from "./hash";

describe("Parser", () => {
  it("parses empty string", async () => {
    const cards = await parseFile("", "test.md", "test");
    expect(cards.length).toBe(0);
  });

  it("parses basic card", async () => {
    const cards = await parseFile(
      "Q: What is Rust?\nA: A systems programming language.",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(1);
    expect(cards[0].content.type).toBe("basic");
    if (cards[0].content.type === "basic") {
      expect(cards[0].content.question).toBe("What is Rust?");
      expect(cards[0].content.answer).toBe("A systems programming language.");
    }
  });

  it("parses multiline Q/A", async () => {
    const cards = await parseFile(
      "Q: foo\nbaz\nbaz\nA: FOO\nBAR\nBAZ",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(1);
    if (cards[0].content.type === "basic") {
      expect(cards[0].content.question).toBe("foo\nbaz\nbaz");
      expect(cards[0].content.answer).toBe("FOO\nBAR\nBAZ");
    }
  });

  it("parses two questions", async () => {
    const cards = await parseFile(
      "Q: foo\nA: bar\n\nQ: baz\nA: quux\n\n",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(2);
  });

  it("parses single cloze", async () => {
    const cards = await parseFile("C: Foo [bar] baz.", "test.md", "test");
    expect(cards.length).toBe(1);
    if (cards[0].content.type === "cloze") {
      expect(cards[0].content.text).toBe("Foo bar baz.");
      expect(cards[0].content.start).toBe(4);
      expect(cards[0].content.end).toBe(6);
    }
  });

  it("parses multiple cloze deletions", async () => {
    const cards = await parseFile(
      "C: Foo [bar] baz [quux].",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(2);
    if (cards[0].content.type === "cloze") {
      expect(cards[0].content.text).toBe("Foo bar baz quux.");
      expect(cards[0].content.start).toBe(4);
      expect(cards[0].content.end).toBe(6);
    }
    if (cards[1].content.type === "cloze") {
      expect(cards[1].content.start).toBe(12);
      expect(cards[1].content.end).toBe(15);
    }
  });

  it("parses cloze with image", async () => {
    const cards = await parseFile(
      "C: Foo [bar] ![](image.jpg) [quux].",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(2);
    if (cards[0].content.type === "cloze") {
      expect(cards[0].content.text).toBe("Foo bar ![](image.jpg) quux.");
      expect(cards[0].content.start).toBe(4);
      expect(cards[0].content.end).toBe(6);
    }
    if (cards[1].content.type === "cloze") {
      expect(cards[1].content.start).toBe(23);
      expect(cards[1].content.end).toBe(26);
    }
  });

  it("parses cloze with escaped brackets", async () => {
    const cards = await parseFile("C: Key: [`\\[`]", "test.md", "test");
    expect(cards.length).toBe(1);
    if (cards[0].content.type === "cloze") {
      expect(cards[0].content.text).toBe("Key: `[`");
      expect(cards[0].content.start).toBe(5);
      expect(cards[0].content.end).toBe(7);
    }
  });

  it("parses cloze with multiple escaped brackets", async () => {
    const cards = await parseFile(
      "C: \\[markdown\\] [`\\[cloze\\]`]",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(1);
    if (cards[0].content.type === "cloze") {
      expect(cards[0].content.text).toBe("[markdown] `[cloze]`");
      expect(cards[0].content.start).toBe(11);
      expect(cards[0].content.end).toBe(19);
    }
  });

  it("parses multi-line cloze", async () => {
    const cards = await parseFile("C: [foo]\n[bar]\nbaz.", "test.md", "test");
    expect(cards.length).toBe(2);
    if (cards[0].content.type === "cloze") {
      expect(cards[0].content.text).toBe("foo\nbar\nbaz.");
      expect(cards[0].content.start).toBe(0);
      expect(cards[0].content.end).toBe(2);
    }
    if (cards[1].content.type === "cloze") {
      expect(cards[1].content.start).toBe(4);
      expect(cards[1].content.end).toBe(6);
    }
  });

  it("errors on question without answer", async () => {
    await expect(
      parseFile("Q: Question without answer", "test.md", "test")
    ).rejects.toThrow();
  });

  it("errors on answer without question", async () => {
    await expect(
      parseFile("A: Answer without question", "test.md", "test")
    ).rejects.toThrow();
  });

  it("errors on cloze without deletions", async () => {
    await expect(parseFile("C: Cloze", "test.md", "test")).rejects.toThrow();
  });

  it("deduplicates identical basic cards", async () => {
    const cards = await parseFile(
      "Q: foo\nA: bar\n\nQ: foo\nA: bar\n\n",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(1);
  });

  it("parses frontmatter deck name", async () => {
    const input = `---\nname = "Custom Deck"\n---\n\nQ: What?\nA: Answer`;
    const cards = await parseFile(input, "test.md", "fallback");
    expect(cards.length).toBe(1);
    expect(cards[0].deckName).toBe("Custom Deck");
  });

  it("uses default deck name without frontmatter", async () => {
    const cards = await parseFile("Q: What?\nA: Answer", "test.md", "MyDeck");
    expect(cards[0].deckName).toBe("MyDeck");
  });

  it("parses separator between basic cards", async () => {
    const cards = await parseFile(
      "Q: foo\nA: bar\n---\nQ: baz\nA: quux",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(2);
  });

  it("errors on separator in question", async () => {
    await expect(
      parseFile("Q: Question\n---\nA: Answer", "test.md", "test")
    ).rejects.toThrow(/separator/);
  });

  it("cloze family hashes match for siblings", async () => {
    const cards = await parseFile(
      "C: Foo [bar] baz [quux].",
      "test.md",
      "test"
    );
    expect(cards.length).toBe(2);
    expect(cards[0].familyHash).toBe(cards[1].familyHash);
    expect(cards[0].hash).not.toBe(cards[1].hash);
  });
});

/**
 * Every card carried `range: [0, 0]`, so nothing could point at where a card
 * actually lives. These are what an "Edit this card" link is built from, and a
 * range that is merely plausible sends you to the wrong part of the file — the
 * one failure mode that makes the feature worse than not having it.
 */
describe("card line ranges", () => {
  it("covers the lines a basic card was parsed from", async () => {
    const cards = await parseFile("Q: one\nA: two", "test.md", "test");
    // 1-based and inclusive, the way GitHub and people count lines.
    expect(cards[0].range).toEqual([1, 2]);
  });

  it("spans a card's continuation lines", async () => {
    const cards = await parseFile(
      "Q: one\ncontinued\nA: two\nalso two",
      "test.md",
      "test"
    );
    expect(cards[0].range).toEqual([1, 4]);
  });

  it("gives each card in a file its own range", async () => {
    const cards = await parseFile(
      "Q: one\nA: two\n\n---\n\nQ: three\nA: four",
      "test.md",
      "test"
    );
    expect(cards.map((c) => c.range)).toEqual([
      [1, 2],
      [6, 7],
    ]);
  });

  it("counts the frontmatter it stripped", async () => {
    const cards = await parseFile(
      '---\nname = "Deck"\n---\nQ: one\nA: two',
      "test.md",
      "test"
    );
    // Parsing sees line 1; the file has it on line 4.
    expect(cards[0].range).toEqual([4, 5]);
  });

  it("stops at the card, not at the blank lines after it", async () => {
    const cards = await parseFile(
      "Q: one\nA: two\n\n\n---\nQ: three\nA: four",
      "test.md",
      "test"
    );
    expect(cards[0].range).toEqual([1, 2]);
  });

  it("runs a final card to the end of the file", async () => {
    const cards = await parseFile("Q: one\nA: two\nmore answer", "test.md", "test");
    expect(cards[0].range).toEqual([1, 3]);
  });

  it("gives every deletion in a cloze block the block's range", async () => {
    const cards = await parseFile(
      "Q: first\nA: card\n---\nC: [Alpha] and [Beta] and [Gamma].",
      "test.md",
      "test"
    );
    const cloze = cards.filter((c) => c.content.type === "cloze");
    expect(cloze).toHaveLength(3);
    // Three cards, one block: editing any of them means editing line 4.
    expect(cloze.map((c) => c.range)).toEqual([
      [4, 4],
      [4, 4],
      [4, 4],
    ]);
  });

  it("spans a multi-line cloze block", async () => {
    const cards = await parseFile(
      "C: [Alpha] is\nspread over [two] lines.",
      "test.md",
      "test"
    );
    expect(cards[0].range).toEqual([1, 2]);
  });
});

/**
 * Format v2 (PLAN-1.0 §2.1): metadata lines at the top of a block. The one
 * property everything else leans on is that none of it touches the v1 hash —
 * the app still keys scheduling on it, so a stamped ID must not reset a card.
 */
describe("card metadata", () => {
  it("reads Tags and Status from the top of a block", async () => {
    const [card] = await parseFile(
      "Tags: capitals, europe\nStatus: draft\nQ: Capital of Estonia?\nA: Tallinn",
      "test.md",
      "test"
    );
    expect(card.key).toBe(`h:${(await basicIdentity("Capital of Estonia?", "Tallinn")).slice(0, 16)}`);
    expect(card.legacyKey).toBeNull();
    expect(card.tags).toEqual(["capitals", "europe"]);
    expect(card.status).toBe("draft");
    expect(card.content).toEqual({
      type: "basic",
      question: "Capital of Estonia?",
      answer: "Tallinn",
    });
  });

  it("gives a card with no metadata its key and the defaults", async () => {
    const [card] = await parseFile("Q: one\nA: two", "test.md", "test");
    expect(card.key).toMatch(/^h:[0-9a-f]{16}$/);
    expect(card.tags).toEqual([]);
    expect(card.status).toBe("active");
  });

  it("leaves hashes and keys alone when metadata is added", async () => {
    const plain = await parseFile(
      "Q: one\nA: two\n---\nC: [Alpha] and [Beta].",
      "test.md",
      "test"
    );
    const tagged = await parseFile(
      "ID: k8q2xv7m\nTags: x\nQ: one\nA: two\n---\nStatus: suspended\nC: [Alpha] and [Beta].",
      "test.md",
      "test"
    );
    expect(tagged.map((c) => [c.hash, c.familyHash, c.key])).toEqual(
      plain.map((c) => [c.hash, c.familyHash, c.key])
    );
  });

  it("starts a card's range at its first metadata line", async () => {
    const cards = await parseFile(
      '---\nname = "D"\n---\nQ: one\nA: two\n\n---\n\nStatus: draft\nTags: t\nQ: three\nA: four\n',
      "test.md",
      "test"
    );
    // So deleting the card in the editor takes its metadata with it.
    expect(cards[1].range).toEqual([9, 12]);
  });

  it("gives every cloze deletion its own key, and the block one family", async () => {
    const cards = await parseFile("C: [Alpha] and [Beta].", "test.md", "test");
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.key)).size).toBe(2);
    expect(cards[0].familyHash).toBe(cards[1].familyHash);
  });

  it("allows blank lines between metadata and the card", async () => {
    const [card] = await parseFile("Status: draft\n\nTags: t\n\nQ: one\nA: two", "test.md", "test");
    expect(card.status).toBe("draft");
    expect(card.tags).toEqual(["t"]);
  });

  it("reads metadata from files with CRLF line endings", async () => {
    const [card] = await parseFile(
      "Tags: t\r\nStatus: suspended\r\nQ: one\r\nA: two\r\n",
      "test.md",
      "test"
    );
    expect(card.tags).toEqual(["t"]);
    expect(card.status).toBe("suspended");
  });

  it("treats metadata-looking lines inside a card as text", async () => {
    // After Q:/A:/C: nothing is metadata, so an answer can say anything.
    const [card] = await parseFile(
      "Q: What does the pod say?\nA: It says\nStatus: Running\nID: none",
      "test.md",
      "test"
    );
    expect(card.content).toMatchObject({ answer: "It says\nStatus: Running\nID: none" });
    expect(card.legacyKey).toBeNull();
    expect(card.status).toBe("active");
  });

  it("only reads metadata where a block begins, not between cards with no separator", async () => {
    const cards = await parseFile("Q: one\nA: two\nTags: t\nQ: three\nA: four", "test.md", "test");
    expect(cards[0].content).toMatchObject({ answer: "two\nTags: t" });
    expect(cards[1].tags).toEqual([]);
  });

  it("errors on metadata with no card after it", async () => {
    await expect(parseFile("Tags: t\n---\nQ: x\nA: y", "test.md", "test")).rejects.toThrow(
      /metadata with no card/
    );
    await expect(parseFile("Q: x\nA: y\n---\nTags: t\n", "test.md", "test")).rejects.toThrow(
      /metadata with no card/
    );
  });

  it("errors on text between metadata and the card", async () => {
    await expect(
      parseFile("Tags: t\nsome note\nQ: x\nA: y", "test.md", "test")
    ).rejects.toThrow(/between a card's metadata/);
  });

  it("errors on a repeated metadata line", async () => {
    await expect(
      parseFile("Tags: a\nTags: b\nQ: x\nA: y", "test.md", "test")
    ).rejects.toThrow(/only have one 'Tags:'/);
  });

  it("errors on an unknown Status or Reverse value", async () => {
    await expect(parseFile("Status: done\nQ: x\nA: y", "test.md", "test")).rejects.toThrow(
      /Status must be/
    );
    await expect(parseFile("Reverse: true\nQ: x\nA: y", "test.md", "test")).rejects.toThrow(
      /Reverse must be/
    );
  });

  it("reports errors at the line people see, frontmatter included", async () => {
    await expect(
      parseFile('---\nname = "D"\n---\n\nStatus: done\nQ: x\nA: y', "deck.md", "test")
    ).rejects.toThrow("Location: deck.md:5");
  });
});

/**
 * A card is its text (PLAN-1.0 §2.7): what the key is made of, and what it is
 * not.
 */
describe("card identity", () => {
  const keyOf = async (text: string) => (await parseFile(text, "t.md", "t")).map((c) => c.key);

  it("ignores how the text is laid out: runs of whitespace, line breaks, indentation", async () => {
    const one = await keyOf("Q: What is the capital of Estonia?\nA: Tallinn");
    expect(await keyOf("Q:   What is the capital\n  of Estonia?  \n\nA:\nTallinn\n")).toEqual(one);
    expect(await keyOf("Q: What is the capital of Estonia?\r\nA: Tallinn\r\n")).toEqual(one);
    expect(await keyOf("Q: What is the capital of Estonia?\nA: Tallinn.")).not.toEqual(one);
  });

  it("does not let text move between question and answer", async () => {
    expect(await keyOf("Q: ab\nA: c")).not.toEqual(await keyOf("Q: a\nA: bc"));
    expect(await keyOf("Q: a b\nA: c")).not.toEqual(await keyOf("Q: a\nA: b c"));
  });

  it("is the same card in any file, deck or position", async () => {
    const [a] = await parseFile("Q: one\nA: two", "a.md", "A");
    const cards = await parseFile('---\nname = "B"\n---\nQ: zero\nA: z\n---\nQ: one\nA: two', "x/b.md", "B");
    expect(cards[1].key).toBe(a.key);
  });

  it("keeps a cloze deletion's key when another deletion is added or removed", async () => {
    const two = await keyOf("C: The [first] and the second.");
    const both = await keyOf("C: The [first] and the [second].");
    expect(both[0]).toBe(two[0]);
    expect(both[1]).not.toBe(both[0]);
  });

  it("changes every deletion's key when the sentence changes", async () => {
    const before = await keyOf("C: The [first] and the [second].");
    const after = await keyOf("C: The [first] and then the [second].");
    expect(after.filter((k) => before.includes(k))).toEqual([]);
  });

  it("tells a deletion from the same words unbracketed elsewhere", async () => {
    const [a] = await keyOf("C: [a] a");
    const [b] = await keyOf("C: a [a]");
    expect(a).not.toBe(b);
  });

  it("keeps the first of two identical cards in a file, and says so", async () => {
    const seen: [number, number][] = [];
    const cards = await parseFile("Q: a\nA: b\n---\nQ:  a\nA: b \n---\nQ: c\nA: d", "t.md", "t", (dup, first) =>
      seen.push([dup.range[0], first.range[0]])
    );
    expect(cards.map((c) => c.range[0])).toEqual([1, 7]);
    expect(seen).toEqual([[4, 1]]);
  });
});

/**
 * `ID:` lines, as early 1.0 builds wrote them (§2.7): still read, never the
 * card's identity, only a record of the key its history was filed under.
 */
describe("legacy ID lines", () => {
  const withId = (id: string) => parseFile(`ID: ${id}\nQ: x\nA: y`, "test.md", "test");

  it("records the key an ID gave each card of its block", async () => {
    const basic = await parseFile("ID: deu\nReverse: yes\nQ: a\nA: b", "t.md", "t");
    expect(basic.map((c) => c.legacyKey)).toEqual(["deu", "deu:r"]);
    const cloze = await parseFile("ID: k3n9wq2p\nC: A [Deployment] manages a [ReplicaSet] of [Pods].", "t.md", "t");
    expect(cloze.map((c) => c.legacyKey)).toEqual(["k3n9wq2p:1", "k3n9wq2p:2", "k3n9wq2p:3"]);
  });

  it("does not change the card's key", async () => {
    const [plain] = await parseFile("Q: x\nA: y", "t.md", "t");
    expect((await withId("ab"))[0].key).toBe(plain.key);
  });

  it("allows the same ID twice: it names nothing any more", async () => {
    const cards = await parseFile("ID: ab\nQ: x\nA: y\n---\nID: ab\nQ: z\nA: w", "test.md", "test");
    expect(cards).toHaveLength(2);
  });

  it.each(["ab", "est-capital", "k8q2xv7m", "0a", "a-", "a".repeat(64)])(
    "accepts %s",
    async (id) => {
      expect((await withId(id))[0].legacyKey).toBe(id);
    }
  );

  it.each(["a", "-ab", "Est", "a_b", "a:b", "a/b", "a b", "ä1", "a".repeat(65), ""])(
    "rejects '%s'",
    async (id) => {
      await expect(withId(id)).rejects.toThrow(/Invalid card ID/);
    }
  );
});

describe("reverse cards", () => {
  it("also emits the card the other way round", async () => {
    const cards = await parseFile(
      "Tags: map\nReverse: yes\nQ: **Germany**\nA: ![Germany](map-deu.png)",
      "test.md",
      "test"
    );
    expect(cards).toHaveLength(2);
    const [forward, reverse] = cards;
    expect(reverse.content).toEqual({
      type: "basic",
      question: "![Germany](map-deu.png)",
      answer: "**Germany**",
    });
    expect(reverse.hash).toBe(await hashBasicCard("![Germany](map-deu.png)", "**Germany**"));
    expect(reverse.key).not.toBe(forward.key);
    // The card it would be if written out by hand.
    const [byHand] = await parseFile("Q: ![Germany](map-deu.png)\nA: **Germany**", "t.md", "t");
    expect(reverse.key).toBe(byHand.key);
    // Same block, same lines, same metadata, one family.
    expect(reverse.range).toEqual(forward.range);
    expect(reverse.tags).toEqual(["map"]);
    expect(reverse.familyHash).toBe(forward.familyHash);
  });

  it("treats Reverse: no as no reverse", async () => {
    expect(await parseFile("Reverse: no\nQ: a\nA: b", "test.md", "test")).toHaveLength(1);
  });

  it("errors on a reversed cloze card", async () => {
    await expect(
      parseFile("Reverse: yes\nC: [a] b", "test.md", "test")
    ).rejects.toThrow(/cloze card cannot be reversed/);
  });
});

describe("frontmatter tags", () => {
  it("gives every card the file's tags, then its own, without repeats", async () => {
    const cards = await parseFile(
      '---\nname = "Nordic"\ntags = ["geo", \'europe\',]\n---\nTags: capitals, geo\nQ: a\nA: b\n---\nQ: c\nA: d',
      "test.md",
      "test"
    );
    expect(cards[0].deckName).toBe("Nordic");
    expect(cards[0].tags).toEqual(["geo", "europe", "capitals"]);
    expect(cards[1].tags).toEqual(["geo", "europe"]);
  });

  it("accepts an empty array and escaped quotes", async () => {
    const [none] = await parseFile("---\ntags = []\n---\nQ: a\nA: b", "t.md", "t");
    expect(none.tags).toEqual([]);
    // JSON escapes are read before the tag is normalised and checked.
    const [escaped] = await parseFile('---\ntags = ["\\u0047eo"]\n---\nQ: a\nA: b', "t.md", "t");
    expect(escaped.tags).toEqual(["geo"]);
  });

  it.each(['tags = "geo"', "tags = [geo]", 'tags = ["geo"', 'tags = ["a" "b"]'])(
    "errors on %s",
    async (line) => {
      await expect(parseFile(`---\n${line}\n---\nQ: a\nA: b`, "t.md", "t")).rejects.toThrow(
        /TOML array of strings/
      );
    }
  );
});

/**
 * Every combination of metadata a block can carry, on both card types: the
 * fields come out as written, and the hashes and keys are the ones the same
 * card has with no metadata at all.
 */
describe("every metadata combination", () => {
  const ids = [null, "combo-id"];
  const tagLines = [null, "a, b"];
  const statuses = [null, "draft", "suspended"] as const;
  const reverses = [null, "yes", "no"];
  const bodies = {
    basic: "Q: question\nA: answer",
    cloze: "C: The [first] and the [second].",
  };

  const combos = ids.flatMap((id) =>
    tagLines.flatMap((tags) =>
      statuses.flatMap((status) =>
        reverses.flatMap((reverse) =>
          (["basic", "cloze"] as const)
            // A reversed cloze is an error, tested above.
            .filter((type) => !(type === "cloze" && reverse === "yes"))
            .map((type) => ({ id, tags, status, reverse, type }))
        )
      )
    )
  );

  it.each(combos)("%o", async ({ id, tags, status, reverse, type }) => {
    const header = [
      id && `ID: ${id}`,
      tags && `Tags: ${tags}`,
      status && `Status: ${status}`,
      reverse && `Reverse: ${reverse}`,
    ].filter(Boolean);
    const text = `---\ntags = ["deck"]\n---\n${[...header, bodies[type]].join("\n")}\n`;
    const cards = await parseFile(text, "t.md", "t");
    const plain = await parseFile(bodies[type], "t.md", "t");

    expect(cards.slice(0, plain.length).map((c) => [c.hash, c.key])).toEqual(plain.map((c) => [c.hash, c.key]));
    for (const card of cards) {
      expect(card.legacyKey === null).toBe(id === null);
      expect(card.tags).toEqual(tags ? ["deck", "a", "b"] : ["deck"]);
      expect(card.status).toBe(status ?? "active");
      expect(card.range).toEqual([4, 4 + header.length + (type === "basic" ? 1 : 0)]);
    }

    const legacy = cards.map((c) => c.legacyKey);
    if (type === "cloze") {
      expect(legacy).toEqual(id ? [`${id}:1`, `${id}:2`] : [null, null]);
    } else if (reverse === "yes") {
      expect(cards).toHaveLength(2);
      expect(legacy).toEqual(id ? [id, `${id}:r`] : [null, null]);
    } else {
      expect(legacy).toEqual([id]);
    }
  });
});

/**
 * `Extra:` (PLAN-1.0 §2.1): an optional last section, shown after reveal. What
 * matters most is that it is not the card: adding, rewording or removing it
 * must leave the hash and the key — and so the card's history — where they were.
 */
describe("the Extra section", () => {
  const variants = (extra: string) => ({
    basic: `Reverse: yes\nQ: question\nA: answer${extra}`,
    cloze: `C: The [first] and the [second].${extra}`,
  });

  it.each(["basic", "cloze"] as const)("reads it on a %s card, multi-line", async (type) => {
    const cards = await parseFile(
      variants("\nExtra: a note\n\n- with a list\n---\nQ: next\nA: card")[type],
      "t.md",
      "t"
    );
    const own = cards.slice(0, 2);
    expect(own.length).toBe(2);
    for (const card of own) expect(card.content.extra).toBe("a note\n\n- with a list");
    // The section ends at the separator, like an answer.
    expect(cards.at(-1)!.content).not.toHaveProperty("extra");
  });

  it("can start on the line after Extra:", async () => {
    const [card] = await parseFile("Q: a\nA: b\nExtra:\n\nsee the docs", "t.md", "t");
    expect(card.content.extra).toBe("see the docs");
  });

  it("is left out of a card without one", async () => {
    const [card] = await parseFile("Q: a\nA: b", "t.md", "t");
    expect(card.content).not.toHaveProperty("extra");
  });

  it("keeps the answer and cloze text it follows unchanged", async () => {
    const [basic] = await parseFile("Q: a\nA: b\nExtra: c", "t.md", "t");
    expect(basic.content).toEqual({ type: "basic", question: "a", answer: "b", extra: "c" });
    const [cloze] = await parseFile("C: [a] b\nExtra: c", "t.md", "t");
    expect(cloze.content).toMatchObject({ text: "a b", start: 0, end: 0, extra: "c" });
  });

  it.each(["basic", "cloze"] as const)(
    "leaves a %s card's hash, family hash and key alone when added, changed or removed",
    async (type) => {
      const identity = async (extra: string) =>
        (await parseFile(variants(extra)[type], "t.md", "t")).map((c) => [
          c.hash,
          c.familyHash,
          c.key,
        ]);
      const without = await identity("");
      expect(await identity("\nExtra: one")).toEqual(without);
      expect(await identity("\nExtra: two\nlines")).toEqual(without);
    }
  );

  it("counts toward the card's line range", async () => {
    const [card] = await parseFile("Q: a\nA: b\nExtra: c\nd\n\n---\nQ: e\nA: f", "t.md", "t");
    expect(card.range).toEqual([1, 4]);
  });

  it.each([
    ["before A:", "Q: a\nExtra: c\nA: b", /Extra: before the card's A: line.*t\.md:2/],
    ["with no card", "Extra: c\nQ: a\nA: b", /Extra: without a card before it/],
    ["as metadata", "Tags: t\nExtra: c\nQ: a\nA: b", /Extra: without a card before it/],
    ["twice", "Q: a\nA: b\nExtra: c\nExtra: d", /only have one Extra: section.*t\.md:4/],
    ["empty", "Q: a\nA: b\nExtra:\n\n---\nQ: c\nA: d", /Extra: with nothing after it.*t\.md:3/],
    ["empty at the end", "C: [a] b\nExtra:   ", /Extra: with nothing after it/],
  ])("errors on Extra: %s", async (_, text, error) => {
    await expect(parseFile(text, "t.md", "t")).rejects.toThrow(error);
  });

  it("is only a section start at the beginning of a line", async () => {
    const [card] = await parseFile("Q: a\nA: b\n  Extra: still the answer", "t.md", "t");
    expect(card.content).toEqual({ type: "basic", question: "a", answer: "b\n  Extra: still the answer" });
  });
});

describe("tag normalisation", () => {
  it.each([
    ["CKA::Type::Syntax Pattern", "cka/type/syntax-pattern"],
    ["  Capitals  ", "capitals"],
    ["two  words\there", "two-words-here"],
    ["/cka/workloads/", "cka/workloads"],
    ["snake_case-and-kebab", "snake_case-and-kebab"],
    ["2026", "2026"],
  ])("reads %j as %j", async (written, tag) => {
    const [card] = await parseFile(`Tags: ${written}\nQ: a\nA: b`, "t.md", "t");
    expect(card.tags).toEqual([tag]);
  });

  it("normalises frontmatter tags the same way", async () => {
    const [card] = await parseFile(
      '---\ntags = ["CKA::Workloads", "Geo Europe"]\n---\nQ: a\nA: b',
      "t.md",
      "t"
    );
    expect(card.tags).toEqual(["cka/workloads", "geo-europe"]);
  });

  it("removes repeats that only differ in spelling, across frontmatter and card", async () => {
    const [card] = await parseFile(
      '---\ntags = ["CKA::Workloads"]\n---\nTags: cka/workloads, Lists, lists, , cka::workloads\nQ: a\nA: b',
      "t.md",
      "t"
    );
    expect(card.tags).toEqual(["cka/workloads", "lists"]);
  });

  it.each(["a.b", "-lead", "a//b", "a/-b", "ä", "c++", "a: b", 'say "hi"', "a / b"])(
    "rejects %j in a Tags: line, naming the line",
    async (tag) => {
      await expect(parseFile(`Q: x\nA: y\n---\nTags: ok, ${tag}\nQ: a\nA: b`, "t.md", "t")).rejects.toThrow(
        /Invalid tag .*Location: t\.md:4/
      );
    }
  );

  it("rejects an invalid frontmatter tag, naming its line", async () => {
    await expect(
      parseFile('---\nname = "D"\ntags = ["fine", "not.fine"]\n---\nQ: a\nA: b', "t.md", "t")
    ).rejects.toThrow(/Invalid tag 'not\.fine'.*Location: t\.md:3/);
  });
});
