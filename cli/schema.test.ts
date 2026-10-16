import { describe, expect, it } from "vitest";
import { CARD_SCHEMA, validateCard } from "./schema";

const basic = { file: "net/tcp.md", type: "basic", question: "Q?", answer: "A" };

describe("validateCard", () => {
  it.each(CARD_SCHEMA.examples as unknown[])("accepts the schema's own example %#", (card) => {
    expect(validateCard(card)).toEqual([]);
  });

  it.each([
    [{ ...basic, answer: undefined }, "", /missing "answer"/],
    [{ ...basic, type: "cloze", text: "a [b]" }, "", /must not have "question"/],
    [{ file: "x.md", type: "cloze", text: "a [b]", reverse: true }, "/reverse", /must be false/],
    [{ ...basic, id: "est-capital" }, "", /"id"/],
    [{ ...basic, status: "done" }, "/status", /one of "active", "draft", "suspended"/],
    [{ ...basic, tags: ["a,b"] }, "/tags/0", /is not valid/],
    [{ ...basic, tags: ["a", "a"] }, "/tags", /repeat/],
    [{ ...basic, question: "one\nA: two" }, "/question", /would end the card early/],
    [{ ...basic, file: "../x.md" }, "/file", /is not valid/],
    [{ ...basic, file: "x.txt" }, "/file", /is not valid/],
    [{ ...basic, colour: "red" }, "", /unknown property "colour"/],
    [{ ...basic, type: "image" }, "/type", /one of "basic", "cloze"/],
    ["not a card", "", /must be an object, got string/],
  ])("rejects %j at %s", (card, path, message) => {
    const errors = validateCard(JSON.parse(JSON.stringify(card)));
    expect(errors).toContainEqual({ path, message: expect.stringMatching(message) });
  });
});
