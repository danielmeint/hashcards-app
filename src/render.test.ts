// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderCardBody } from "./render";
import { Card } from "./types";

const card = (question: string, filePath = "aws.md"): Card => ({
  deckName: "deck",
  filePath,
  range: [1, 2],
  content: { type: "basic", question, answer: "A" },
  hash: "h",
  familyHash: null,
});

describe("image URLs in card text", () => {
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
