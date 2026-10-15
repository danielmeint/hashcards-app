import { describe, it, expect } from "vitest";
import { CardKey, formatKey, isValidId, parseKey } from "./card-key";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("card keys", () => {
  const cases: [CardKey, string][] = [
    [{ kind: "basic", id: "est-capital" }, "est-capital"],
    [{ kind: "reverse", id: "k8q2xv7m" }, "k8q2xv7m:r"],
    [{ kind: "cloze", id: "k3n9wq2p", n: 1 }, "k3n9wq2p:1"],
    [{ kind: "cloze", id: "k3n9wq2p", n: 12 }, "k3n9wq2p:12"],
    [{ kind: "hash", hash: HASH }, "h:0123456789abcdef"],
  ];

  it.each(cases)("writes %o as %s", (key, text) => {
    expect(formatKey(key)).toBe(text);
  });

  it.each(cases)("reads %o back from %s", (key, text) => {
    const expected = key.kind === "hash" ? { kind: "hash", hash: HASH.slice(0, 16) } : key;
    expect(parseKey(text)).toEqual(expected);
  });

  it("prefixes and reads back a subscribed collection's keys", () => {
    const text = formatKey({ kind: "cloze", id: "geo", n: 2 }, "someone/cards");
    expect(text).toBe("someone/cards/geo:2");
    expect(parseKey(text)).toEqual({ kind: "cloze", id: "geo", n: 2, repo: "someone/cards" });
  });

  it.each([
    "",
    "a", // too short to be an ID
    "Est",
    "ab:0", // deletions count from 1
    "ab:01",
    "ab:x",
    "ab:r:1",
    "h:0123", // a truncated hash
    "h:0123456789ABCDEF",
    "cards/ab", // a repo needs an owner
    "a/b/c/ab",
    "/ab",
  ])("rejects '%s'", (text) => {
    expect(parseKey(text)).toBeNull();
  });

  it("never reads an ID as the hash prefix", () => {
    // `h` alone is too short to be an ID, which is what keeps `h:` unambiguous.
    expect(isValidId("h")).toBe(false);
    expect(parseKey("hh:1")).toEqual({ kind: "cloze", id: "hh", n: 1 });
  });
});
