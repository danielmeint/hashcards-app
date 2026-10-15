// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadMarkdown, renderCardBody } from "./render";
import { updateMedia } from "./db";
import { prepareMedia } from "./media";
import { Card } from "./types";
import { parseFile } from "./parser";

const card = (question: string, filePath = "aws.md"): Card => ({
  deckName: "deck",
  repo: "someone/cards",
  filePath,
  range: [1, 2],
  content: { type: "basic", question, answer: "A" },
  hash: "h",
  familyHash: null,
  id: null, key: "", tags: [], status: "active",
});

describe("media in card text", () => {
  // Markdown is not in the initial bundle any more; `renderDrill` awaits it at
  // the door so that everything past that stays synchronous.
  beforeAll(() => loadMarkdown());

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "repos",
      JSON.stringify([
        { owner: "someone", repo: "cards", branch: "main" },
        { owner: "teacher", repo: "course", branch: "cards-v2", readOnly: true },
      ])
    );
  });

  it("falls back to GitHub for a file sync has not stored", () => {
    const html = renderCardBody(card("![](diagram.png)"));
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/someone/cards/main/diagram.png"'
    );
  });

  it("resolves against the directory the card lives in", () => {
    const html = renderCardBody(card("![](diagram.png)", "aws/s3.md"));
    expect(html).toContain("/someone/cards/main/aws/diagram.png");
  });

  it("resolves @/ against the repository root", () => {
    const html = renderCardBody(card("![](@/img/diagram.png)", "aws/s3.md"));
    expect(html).toContain("/someone/cards/main/img/diagram.png");
  });

  it("resolves against the card's own collection, on its own branch", () => {
    // This used to resolve against whichever repo was configured first, so a
    // subscribed collection's images pointed into yours.
    const html = renderCardBody({ ...card("![](diagram.png)"), repo: "teacher/course" });
    expect(html).toContain("/teacher/course/cards-v2/diagram.png");
  });

  it("uses the stored copy when there is one", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:stored" }));
    await updateMedia(
      [{ repo: "someone/cards", path: "aws/diagram.png", sha: "s", type: "image/png", bytes: new ArrayBuffer(4) }],
      []
    );
    const withImage = card("![a diagram](diagram.png)", "aws/s3.md");
    await prepareMedia([withImage]);

    const html = renderCardBody(withImage);
    expect(html).toContain('src="blob:stored"');
    expect(html).toContain('alt="a diagram"');
    expect(html).not.toContain("raw.githubusercontent.com");
  });

  it("leaves an absolute URL alone", () => {
    const html = renderCardBody(card("![](https://example.com/a.png)"));
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it("plays audio rather than showing it as a broken image", () => {
    const html = renderCardBody(card("![](audio/parande.mp3)"));
    expect(html).toContain("<audio controls");
    expect(html).toContain("/someone/cards/main/audio/parande.mp3");
  });

  it("leaves the path alone for a card in no configured repo", () => {
    localStorage.clear();
    const html = renderCardBody(card("![](diagram.png)"));
    expect(html).toContain('src="diagram.png"');
    expect(html).not.toContain("raw.githubusercontent.com");
  });
});

/**
 * A cloze deletion used to be a placeholder word spliced into the markdown
 * source and `String.replace`d out of the rendered HTML. It is a tokenizer
 * now, which is what these are about.
 */
describe("cloze rendering", () => {
  beforeAll(() => loadMarkdown());
  beforeEach(() => localStorage.clear());

  const clozeCard = async (text: string): Promise<Card> => {
    const [card] = await parseFile(`C: ${text}\n`, "aws.md", "aws");
    return { ...card, repo: "someone/cards" };
  };

  it("shows the blank and the answer together, from one parse", async () => {
    const html = renderCardBody(await clozeCard("The capital of France is [Paris]."));

    expect(html).toContain('<span class="cloze">');
    expect(html).toContain('<span class="cloze-reveal">Paris</span>');
    // The prose around it is rendered once, as prose.
    expect(html).toContain("The capital of France is");
  });

  it("renders markdown inside the deletion without wrapping it in a paragraph", async () => {
    const html = renderCardBody(await clozeCard("It is [**very** important]."));

    expect(html).toContain(
      '<span class="cloze-reveal"><strong>very</strong> important</span>'
    );
    // The answer used to be parsed a second time, as a document, and the <p>
    // that produced was stripped back off with a regex.
    expect(html).not.toContain("<p><strong>very</strong>");
  });

  it("does not treat a replacement pattern in the answer as one", async () => {
    // `String.replace` reads `$&` in the replacement as "the matched text", so
    // this answer used to render as the placeholder word it was replacing.
    const html = renderCardBody(await clozeCard("The flag is [$&] in sed."));

    expect(html).toContain('<span class="cloze-reveal">$&amp;</span>');
    expect(html).not.toContain("PLACEHOLDER");
  });

  it("keeps its place in text that is not one byte per character", async () => {
    const html = renderCardBody(await clozeCard("Un café coûte [trois] euros"));

    expect(html).toContain('<span class="cloze-reveal">trois</span>');
    expect(html).toContain("Un café coûte");
    expect(html).toContain("euros");
  });
});

/**
 * The `Extra:` section is rendered with the card but hidden until reveal, by
 * the same `.answer` rule that hides a basic card's back.
 */
describe("the Extra section", () => {
  beforeAll(() => loadMarkdown());
  beforeEach(() => localStorage.clear());

  const parsed = async (text: string): Promise<Card> => {
    const [card] = await parseFile(text, "aws.md", "aws");
    return { ...card, repo: "someone/cards" };
  };

  /** The element holding the extra, from the HTML as the drill mounts it. */
  const extraOf = (html: string): Element | null => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root.querySelector(".extra");
  };

  it("follows a basic card's answer, hidden like it", async () => {
    const html = renderCardBody(await parsed("Q: Capital of Estonia?\nA: Tallinn\nExtra: *Reval* in German"));
    const extra = extraOf(html);
    expect(extra?.classList.contains("answer")).toBe(true);
    expect(extra?.innerHTML).toContain("<em>Reval</em> in German");
    expect(html.indexOf("Tallinn")).toBeLessThan(html.indexOf("Reval"));
  });

  it("follows a cloze card's text, hidden until reveal", async () => {
    const html = renderCardBody(await parsed("C: The capital of [Norway] is Oslo.\nExtra: See `docs/oslo.md`"));
    const extra = extraOf(html);
    expect(extra?.classList.contains("answer")).toBe(true);
    expect(extra?.innerHTML).toContain("<code>docs/oslo.md</code>");
  });

  it("is absent from a card without one", async () => {
    expect(extraOf(renderCardBody(await parsed("Q: a\nA: b")))).toBeNull();
    expect(extraOf(renderCardBody(await parsed("C: [a] b")))).toBeNull();
  });
});
