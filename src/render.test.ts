// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { loadMarkdown, renderCardBody } from "./render";
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
});

describe("image URLs in card text", () => {
  // Markdown is not in the initial bundle any more; `renderDrill` awaits it at
  // the door so that everything past that stays synchronous.
  beforeAll(() => loadMarkdown());

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("github_owner", "daniel");
    localStorage.setItem("github_repo", "my-hashcards");
    localStorage.setItem("github_branch", "main");
  });

  it("resolves a relative image against the configured repo", () => {
    const html = renderCardBody(card("![](diagram.png)"));
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/daniel/my-hashcards/main/diagram.png"'
    );
  });

  it("resolves it against the directory the card lives in", () => {
    const html = renderCardBody(card("![](diagram.png)", "aws/s3.md"));
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/daniel/my-hashcards/main/aws/diagram.png"'
    );
  });

  it("leaves an absolute URL alone", () => {
    const html = renderCardBody(card("![](https://example.com/a.png)"));
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it("follows the branch the repo is configured on", () => {
    localStorage.setItem("github_branch", "cards-v2");
    const html = renderCardBody(card("![](diagram.png)"));
    expect(html).toContain("/my-hashcards/cards-v2/diagram.png");
  });

  it("leaves the path alone when there is no repo to resolve it against", () => {
    localStorage.clear();
    const html = renderCardBody(card("![](diagram.png)"));
    // This used to build `https://raw.githubusercontent.com///main/diagram.png`
    // from its own reading of the config, which is a 404 with extra steps.
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
