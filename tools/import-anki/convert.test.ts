import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { normaliseTag, parseFile, TAG_PATTERN as PARSER_TAG_PATTERN } from "../../src/parser";
import {
  assignCardIds,
  convertCloze,
  convertMarkdown,
  convertRawHtml,
  deckDisplayName,
  deckToPath,
  escapeBrackets,
  flattenCloze,
  slugify,
  TAG_PATTERN,
  toCardId,
  toTag,
} from "./convert.ts";

/** What the app's parser makes of a `C:` block: each deletion's text. */
async function deletions(clozeText: string): Promise<string[]> {
  const cards = await parseFile(`C: ${clozeText}\n`, "t.md", "t");
  return cards.map((c) => {
    if (c.content.type !== "cloze") throw new Error("not cloze");
    const bytes = new TextEncoder().encode(c.content.text);
    return new TextDecoder().decode(bytes.slice(c.content.start, c.content.end + 1));
  });
}

describe("convertCloze", () => {
  it("turns {{cN::…}} into brackets", () => {
    const r = convertCloze("A {{c1::Deployment}} manages a {{c2::ReplicaSet}}.");
    expect(r.text).toBe("A [Deployment] manages a [ReplicaSet].");
    expect([...r.cNumToIndex]).toEqual([[1, 1], [2, 2]]);
    expect(r.warnings).toEqual([]);
  });

  it("numbers deletions by first appearance, not by c-number", () => {
    const r = convertCloze("{{c3::x}} {{c1::y}} {{c2::z}}");
    expect(r.text).toBe("[x] [y] [z]");
    // Anki's c3 card is hashcards' first deletion.
    expect(r.cNumToIndex.get(3)).toBe(1);
    expect(r.cNumToIndex.get(1)).toBe(2);
    expect(r.cNumToIndex.get(2)).toBe(3);
  });

  it("drops hints, with a warning", () => {
    const r = convertCloze("Capital: {{c1::Tallinn::city}}");
    expect(r.text).toBe("Capital: [Tallinn]");
    expect(r.deletions[0].hint).toBe("city");
    expect(r.warnings.join()).toMatch(/hint "city" dropped/);
  });

  it("flags a c-number used twice and maps it to its first deletion", () => {
    const r = convertCloze("{{c1::a}} and {{c2::b}} and {{c1::c}}");
    expect(r.text).toBe("[a] and [b] and [c]");
    expect(r.cNumToIndex.get(1)).toBe(1);
    expect(r.cNumToIndex.get(2)).toBe(2);
    expect(r.warnings.join()).toMatch(/c1 is used more than once.*deletion 3/);
  });

  it("flattens nested clozes, with a warning", () => {
    const r = convertCloze("{{c1::outer {{c2::inner}} end}} tail");
    expect(r.text).toBe("[outer inner end] tail");
    expect(r.cNumToIndex.has(2)).toBe(false);
    expect(r.warnings.join()).toMatch(/nested/);
  });

  it("escapes literal brackets, including inside code spans and deletions", async () => {
    const src = "`rules[].host` → {{c1::`matches[].path`}}";
    const r = convertCloze(src);
    expect(r.text).toBe("`rules\\[\\].host` → [`matches\\[\\].path`]");
    expect(await deletions(r.text)).toEqual(["`matches[].path`"]);
  });

  it("keeps Markdown links and images working", async () => {
    const r = convertCloze("See [docs](https://x.io) and ![map](m.png): {{c1::here}}");
    expect(await deletions(r.text)).toEqual(["here"]);
  });

  it("keeps a deletion after a backslash a deletion", async () => {
    const r = convertCloze("path C:\\{{c1::Windows}}");
    expect(await deletions(r.text)).toEqual(["Windows"]);
    expect(r.warnings.join()).toMatch(/backslash/);
  });

  it("leaves a hard-break backslash before a deletion on the next line alone", async () => {
    const r = convertCloze("one\\\n{{c1::two}}");
    expect(r.text).toBe("one\\\n[two]");
    expect(r.warnings).toEqual([]);
  });

  it("reports a note with no deletions", () => {
    expect(convertCloze("nothing here").warnings).toEqual(["cloze note has no {{cN::…}} deletions"]);
  });

  it("flattenCloze strips markers innermost first", () => {
    expect(flattenCloze("a {{c1::b {{c2::c::h}} d}} e")).toBe("a b c d e");
  });

  it("escapeBrackets leaves escaped brackets alone", () => {
    expect(escapeBrackets("a[1] \\[x\\]")).toBe("a\\[1\\] \\[x\\]");
  });
});

describe("card IDs", () => {
  it("keeps valid keys as they are", () => {
    expect(toCardId("cka-wl-set-image")).toBe("cka-wl-set-image");
  });

  it("slugs invalid keys deterministically", () => {
    expect(toCardId("Kubelet Files")).toBe("kubelet-files");
    expect(toCardId("café_au_lait")).toBe("cafe-au-lait");
    expect(toCardId("-leading")).toBe("leading");
  });

  it("falls back to a stable hash when nothing is sluggable", () => {
    const id = toCardId("日本");
    expect(id).toMatch(/^k-[a-z0-9]+$/);
    expect(toCardId("日本")).toBe(id);
    expect(toCardId("x")).toMatch(/^k-/); // one character is too short
  });

  it("truncates at a word boundary to 64", () => {
    const id = toCardId("Word ".repeat(30));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.endsWith("-")).toBe(false);
    expect(id).toMatch(/^(word-)*word$/);
  });

  it("resolves slug collisions without moving valid keys", () => {
    const ids = assignCardIds(["Foo", "foo", "FOO"]);
    expect(ids.get("foo")).toBe("foo");
    expect(ids.get("Foo")).toBe("foo-2");
    expect(ids.get("FOO")).toBe("foo-3");
  });

  it("slugify matches ankictl's rules", () => {
    expect(slugify("Workloads And Scheduling")).toBe("workloads-and-scheduling");
    expect(slugify("  a -- b  ")).toBe("a-b");
  });
});

describe("tags", () => {
  it("uses the parser's tag pattern", () => {
    expect(TAG_PATTERN.source).toBe(PARSER_TAG_PATTERN.source);
  });

  it.each([
    ["CKA::Type::Syntax-Pattern", "cka/type/syntax-pattern"],
    ["CKA::D4-Helm-Kustomize-Extensions", "cka/d4-helm-kustomize-extensions"],
    ["CKA::Type::JSONPath-Config", "cka/type/jsonpath-config"],
    ["agent-drafted", "agent-drafted"],
    ["Two Words", "two-words"],
    ["::leading::", "leading"],
  ])("writes %s as %s, which the parser leaves alone", (anki, tag) => {
    expect(toTag(anki)).toBe(tag);
    expect(normaliseTag(anki)).toBe(tag);
    expect(normaliseTag(tag)).toBe(tag);
  });

  it.each(["c++", "a.b", "über", "", "::"])("has no form for %j", (anki) => {
    expect(toTag(anki)).toBeNull();
  });
});

describe("deck paths and names", () => {
  it("maps the deck hierarchy to a path", () => {
    expect(deckToPath("Cka::Workloads And Scheduling")).toBe("cka/workloads-and-scheduling.md");
    expect(deckToPath("Sre::Networking::TCP/IP")).toBe("sre/networking/tcp-ip.md");
  });

  it("makes a readable name", () => {
    expect(deckDisplayName("Cka::Workloads And Scheduling", ["CKA"])).toBe("CKA: Workloads and Scheduling");
    expect(deckDisplayName("Cka::Services And Networking")).toBe("Cka: Services and Networking");
    expect(deckDisplayName("The Basics::Of Things")).toBe("The Basics: Of Things");
  });
});

describe("convertMarkdown", () => {
  const marked = new Marked();

  it("keeps trailing-backslash line breaks, which marked also renders as <br>", () => {
    const src = "**Guaranteed**: requests == limits\\\n**BestEffort**: nothing";
    const r = convertMarkdown(src);
    expect(r.text).toBe(src);
    expect(r.warnings).toEqual([]);
    expect(marked.parse(r.text)).toContain("<br>");
  });

  it("leaves tildes GFM would not strike through alone", () => {
    const src = "refresh (~1 min), and ~2 billion; `~/.kube` stays";
    expect(convertMarkdown(src)).toEqual({ text: src, warnings: [] });
  });

  it("escapes tildes when GFM would strike text through", () => {
    const src = "waits ~1 min, 2~3 retries; `~/.kube` stays";
    expect(marked.parse(src)).toContain("<del>");
    const r = convertMarkdown(src);
    expect(r.text).toBe("waits \\~1 min, 2\\~3 retries; `~/.kube` stays");
    expect(marked.parse(r.text)).not.toContain("<del>");
    expect(r.warnings.join()).toMatch(/strike/);
  });

  it("rewrites a --- thematic break, which would end the card", () => {
    const r = convertMarkdown("one\n\n---\n\ntwo");
    expect(r.text).toBe("one\n\n***\n\ntwo");
    expect(r.warnings.join()).toMatch(/thematic break/);
  });

  it("flags a setext heading underline and a line that would start a card", () => {
    expect(convertMarkdown("Title\n---").warnings.join()).toMatch(/setext/);
    expect(convertMarkdown("x\nQ: y").warnings.join()).toMatch(/starts a new card/);
    expect(convertMarkdown("x\nExtra: y").warnings.join()).toMatch(/"Extra:", which starts a new card or section/);
  });

  it("ignores --- inside a fenced block", () => {
    expect(convertMarkdown("```yaml\n---\nkind: Pod\n```").warnings).toEqual([]);
  });

  it("flags $…$ the app would typeset, but not shell in code", () => {
    expect(convertMarkdown("costs $x^2$").warnings.join()).toMatch(/maths/);
    expect(convertMarkdown("`chown $(id -u):$(id -g)` and `$TOKEN`").warnings).toEqual([]);
  });
});

describe("convertRawHtml", () => {
  it("rewrites MathJax delimiters for KaTeX", () => {
    const r = convertRawHtml("<p>\\(10^{-3}\\) and \\[x^2\\]</p>");
    expect(r.text).toBe("<p>$10^{-3}$ and $$x^2$$</p>");
    expect(r.warnings.join()).toMatch(/MathJax/);
  });
});
