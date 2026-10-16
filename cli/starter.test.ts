import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hc } from "./test-helpers";
import { loadCollection } from "./collection";
import { initFiles } from "./commands/init";

/**
 * `starter/` becomes the root of the `hashcards-starter` template repo, which
 * is what "Use this template" copies into a new user's account, and it is what
 * the in-app demo shows. So it has to be a clean collection on its own terms:
 * read by the real parser, linted by the real `hc lint`, and carrying exactly
 * the files `hc init` would write.
 */

const STARTER = join(import.meta.dirname, "..", "starter");
const read = (path: string) => readFileSync(join(STARTER, path), "utf8");

describe("the starter collection", () => {
  it("lints clean, warnings included", async () => {
    const run = await hc(["lint", "--strict", "--json", "--repo", STARTER]);
    expect(run.json()).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(run.code).toBe(0);
  });

  it("has what `hc init` writes, byte for byte", () => {
    // AGENTS.md and the workflow are copies of the templates. Asserted rather
    // than generated so the template repo is a plain folder the lead can push;
    // when a template changes, this fails until the copy is refreshed.
    for (const { path, text } of initFiles(STARTER)) {
      expect(read(path), path).toBe(text);
    }
  });

  it("shows off every feature of the format, in a few small decks", async () => {
    const { files, cards } = await loadCollection(STARTER);
    expect(files.map((f) => f.path)).toEqual([
      "Geography.md",
      "Maths.md",
      "Programming.md",
      "Welcome.md",
      "languages/Spanish.md",
    ]);
    const active = cards.filter((c) => c.status === "active");
    expect(active.length).toBeGreaterThanOrEqual(30);
    expect(active.length).toBeLessThanOrEqual(40);

    const drafts = cards.filter((c) => c.status === "draft");
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.length).toBeLessThanOrEqual(3);

    expect(cards.every((c) => c.legacyKey === null)).toBe(true);
    // A reversed card: two basic cards of one family.
    const families = cards.filter((c) => c.content.type === "basic").map((c) => c.familyHash);
    expect(families.some((f, i) => families.indexOf(f) !== i)).toBe(true);
    expect(cards.some((c) => c.content.type === "cloze")).toBe(true);
    expect(cards.some((c) => c.content.extra)).toBe(true);
    expect(cards.some((c) => c.tags.length > 1)).toBe(true);

    const text = files.map((f) => f.text).join("\n");
    expect(text).toMatch(/^```python$/m);
    expect(text).toMatch(/^\|---\|/m);
    expect(text).toContain("$$");
  });

  it("uses only single blanks, so each deletion stands alone", async () => {
    const { cards } = await loadCollection(STARTER);
    const families = cards.filter((c) => c.content.type === "cloze").map((c) => c.familyHash);
    expect(new Set(families).size).toBe(families.length);
  });

  it("explains itself to the person who just created it", () => {
    const readme = read("README.md");
    expect(readme).toContain("https://hashcards.dev");
    expect(readme).toMatch(/include\s+this\s+repository/i);
    expect(readme).toContain("AGENTS.md");
  });
});
