import { describe, it, expect } from "vitest";
import { parseFile } from "./parser";

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
