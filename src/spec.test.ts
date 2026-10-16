import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFile } from "./parser";
import { parseLine } from "./core/events";

/**
 * The examples in CARD_FORMAT_SPEC.md, read out of the document itself. A spec
 * whose examples are wrong teaches agents to write cards that fail, and nothing
 * else would notice.
 */
const SPEC = readFileSync(new URL("../CARD_FORMAT_SPEC.md", import.meta.url), "utf8");

/** The fenced code blocks under `heading`, in order. */
function blocksUnder(heading: string): string[] {
  const section = SPEC.split(/^## /m).find((s) => s.startsWith(heading));
  if (!section) throw new Error(`No section '${heading}' in the spec`);
  return [...section.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

const KEY = /^h:[0-9a-f]{16}$/;

describe("the format spec's examples", () => {
  it("opening example parses as described", async () => {
    const cards = await parseFile(blocksUnder("Overview")[0], "t.md", "t");
    expect(cards.map((c) => [c.content.type, c.status, c.tags])).toEqual([
      ["basic", "active", ["geo", "europe", "capitals"]],
      ["basic", "active", ["geo", "europe"]],
      ["basic", "active", ["geo", "europe"]],
      ["cloze", "draft", ["geo", "europe"]],
      ["cloze", "draft", ["geo", "europe"]],
    ]);
    for (const card of cards) expect(card.key).toMatch(KEY);
    expect(cards[3].content.extra).toMatch(/^A rollout creates/);
  });

  it("Extra section example parses as described", async () => {
    const block = blocksUnder("Card Types").find((b) => b.includes("Extra:"))!;
    const cards = await parseFile(block, "t.md", "t");
    expect(cards.map((c) => c.content.extra)).toEqual([
      "Called *Reval* until 1918.",
      "The container name comes before `=`.\n\nSee `kubectl set image --help`.",
      "The container name comes before `=`.\n\nSee `kubectl set image --help`.",
    ]);
  });

  it("tag example normalises as described", async () => {
    const block = blocksUnder("Metadata Lines").find((b) => b.includes("CKA::"))!;
    const [card] = await parseFile(`${block}Q: a\nA: b`, "t.md", "t");
    expect(card.tags).toEqual(["cka/type/syntax-pattern", "lists"]);
  });

  it("key example is the key, however the card is laid out", async () => {
    const key = /is `(h:[0-9a-f]{16})`,\nwritten on one line or on three/.exec(SPEC)![1];
    for (const text of [
      "Q: What is the capital of Estonia?\nA: Tallinn",
      "Q:\n  What is the capital of\n  Estonia?\nA:   Tallinn  ",
      "Tags: capitals\nQ: What is the capital of Estonia?\nA: Tallinn\nExtra: Reval",
    ]) {
      const [card] = await parseFile(text, "t.md", "t");
      expect(card.key).toBe(key);
    }
  });

  it("link example links the Estonia card to its edited self", async () => {
    const line = blocksUnder("Card Keys").find((b) => b.includes('"kind":"link"'))!.trim();
    const parsed = parseLine(line);
    expect(parsed.ok).toBe(true);
    const [before] = await parseFile("Q: What is the capital of Estonia?\nA: Tallinn", "t.md", "t");
    const [after] = await parseFile("Q: What is the capital of Estonia?\nA: **Tallinn**", "t.md", "t");
    expect(parsed.ok && parsed.event).toMatchObject({ kind: "link", from: before.key, card: after.key });
  });

  it("complete example produces the cards its table lists", async () => {
    const cards = await parseFile(blocksUnder("Complete Example")[0], "t.md", "t");
    expect(cards).toHaveLength(10);
    for (const card of cards) expect(card.key).toMatch(KEY);
    expect(new Set(cards.map((c) => c.key)).size).toBe(10);
    expect(cards.map((c) => c.status)).toEqual([
      "active", "active", "active", "active", "suspended", "suspended", "suspended", "active", "active", "draft",
    ]);
    expect(cards.filter((c) => c.status === "active")).toHaveLength(6);
    expect(cards[1].tags).toEqual(["science", "lists"]);
    expect(cards.filter((c) => c.content.extra)).toHaveLength(2);
  });
});
