import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stampIds } from "./card-ids";
import { parseFile } from "./parser";

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

describe("the format spec's examples", () => {
  it("opening example parses as described", async () => {
    const cards = await parseFile(blocksUnder("Overview")[0], "t.md", "t");
    expect(cards.map((c) => [c.key, c.status, c.tags])).toEqual([
      ["est-capital", "active", ["geo", "europe", "capitals"]],
      ["k8q2xv7m", "active", ["geo", "europe"]],
      ["k8q2xv7m:r", "active", ["geo", "europe"]],
      ["k3n9wq2p:1", "draft", ["geo", "europe"]],
      ["k3n9wq2p:2", "draft", ["geo", "europe"]],
    ]);
  });

  it("complete example produces the cards its table lists", async () => {
    const cards = await parseFile(blocksUnder("Complete Example")[0], "t.md", "t");
    expect(cards).toHaveLength(10);
    expect(cards.map((c) => c.key.replace(/^h:.*/, "h:…"))).toEqual([
      "avogadro",
      "noble-gases",
      "water:1",
      "water:2",
      "ph-scale:1",
      "ph-scale:2",
      "ph-scale:3",
      "benzene",
      "benzene:r",
      "h:…",
    ]);
    expect(cards.filter((c) => c.status === "active")).toHaveLength(6);
    expect(cards[1].tags).toEqual(["science", "lists"]);
  });

  it("stamping example is what stamping does", () => {
    const [before, after] = blocksUnder("Stamping IDs");
    const ids = ["m3x9p2qa", "7hc0wd5n"];
    expect(stampIds(before, () => ids.shift()!)).toBe(after);
  });
});
