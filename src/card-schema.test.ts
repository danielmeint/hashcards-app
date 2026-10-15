import { describe, it, expect } from "vitest";
import schema from "../schema/card.schema.json";
import { ID_PATTERN } from "./card-key";
import { parseFile, TAG_PATTERN } from "./parser";

/**
 * `schema/card.schema.json` is the shape agents emit; the parser is what reads
 * the file it ends up in. These keep the two from drifting apart. (Validating
 * against the schema itself is left to whatever validator the caller uses —
 * there is none in this repo's dependencies, and one test is not worth adding.)
 */

type SchemaCard = {
  file: string;
  type: "basic" | "cloze";
  id?: string;
  question?: string;
  answer?: string;
  text?: string;
  extra?: string;
  tags?: string[];
  reverse?: boolean;
  status?: "active" | "draft" | "suspended";
};

/** A card block as the spec says a schema card is written. */
function toBlock(card: SchemaCard): string {
  const meta = [
    card.id && `ID: ${card.id}`,
    card.tags?.length && `Tags: ${card.tags.join(", ")}`,
    card.reverse && "Reverse: yes",
    card.status && card.status !== "active" && `Status: ${card.status}`,
  ].filter(Boolean);
  const body =
    card.type === "basic" ? `Q: ${card.question}\nA: ${card.answer}` : `C: ${card.text}`;
  const extra = card.extra === undefined ? [] : [`Extra: ${card.extra}`];
  return [...meta, body, ...extra].join("\n");
}

describe("the card JSON Schema", () => {
  it("allows exactly the IDs the parser does", () => {
    expect(schema.properties.id.pattern).toBe(ID_PATTERN.source);
  });

  it("allows exactly the tags the parser does, once normalised", () => {
    // `source` escapes the slashes a JSON string leaves bare.
    expect(new RegExp(schema.properties.tags.items.pattern).source).toBe(TAG_PATTERN.source);
  });

  it("knows every field the parser reads off a block", () => {
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["answer", "extra", "file", "id", "question", "reverse", "status", "tags", "text", "type"]
    );
  });

  it("has an example of every optional field", () => {
    const used = new Set((schema.examples as object[]).flatMap((e) => Object.keys(e)));
    expect([...used].sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it("offers the statuses the parser produces", () => {
    expect(schema.properties.status.enum).toEqual(["active", "draft", "suspended"]);
  });

  it.each(schema.examples as SchemaCard[])("has examples that parse as described: %o", async (card) => {
    const parsed = await parseFile(toBlock(card), card.file, "deck");
    const expected = card.type === "cloze" ? (card.text!.match(/\[/g) ?? []).length : 1;
    expect(parsed).toHaveLength(card.reverse ? 2 : expected);
    for (const c of parsed) {
      expect(c.id).toBe(card.id ?? null);
      expect(c.tags).toEqual(card.tags ?? []);
      expect(c.status).toBe(card.status ?? "active");
      expect(c.content.extra).toBe(card.extra);
    }
  });

  it("rejects side text the parser would split, and allows what it would not", () => {
    const side = new RegExp(schema.$defs.side.allOf[1].pattern);
    expect(side.test("one\nA: two")).toBe(false);
    expect(side.test("one\n---\ntwo")).toBe(false);
    expect(side.test("one\nExtra: two")).toBe(false);
    expect(side.test("one\n  ---  ")).toBe(false);
    expect(side.test("one\n\n- two\n----\nC:ats")).toBe(false);
    expect(side.test("one\n\n- two\n----")).toBe(true);
    expect(side.test("A: on the first line is part of the Q: line")).toBe(true);
  });
});
