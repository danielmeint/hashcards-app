import { describe, it, expect } from "vitest";
import { mediaRefs, resolveMediaPath } from "./media";

describe("resolving a card's media path", () => {
  it("is relative to the deck file's directory", () => {
    expect(resolveMediaPath("diagram.png", "aws/s3.md")).toBe("aws/diagram.png");
    expect(resolveMediaPath("diagram.png", "top.md")).toBe("diagram.png");
  });

  it("treats @/ as the repository root", () => {
    expect(resolveMediaPath("@/img/a.webp", "deep/er/deck.md")).toBe("img/a.webp");
  });

  it("follows . and ..", () => {
    expect(resolveMediaPath("../img/./a.png", "aws/s3.md")).toBe("img/a.png");
  });

  it("refuses to climb above the repository", () => {
    expect(resolveMediaPath("../../a.png", "aws/s3.md")).toBeNull();
  });

  it("is not a repository path for a URL", () => {
    expect(resolveMediaPath("https://example.com/a.png", "a.md")).toBeNull();
    expect(resolveMediaPath("data:image/png;base64,AA", "a.md")).toBeNull();
    expect(resolveMediaPath("//cdn.example.com/a.png", "a.md")).toBeNull();
  });

  it("decodes what markdown percent-encoded", () => {
    expect(resolveMediaPath("my%20diagram.png", "a.md")).toBe("my diagram.png");
  });
});

describe("finding a card's media", () => {
  const basic = (question: string, answer = "A") => ({
    filePath: "aws/s3.md",
    content: { type: "basic" as const, question, answer },
  });

  it("finds images and audio on both faces", () => {
    expect(mediaRefs(basic("![](q.png)", "![](@/audio/a.mp3)")).sort()).toEqual([
      "audio/a.mp3",
      "aws/q.png",
    ]);
  });

  it("finds them in a cloze card's text", () => {
    const cloze = {
      filePath: "x.md",
      content: { type: "cloze" as const, text: "See ![](a.png) for [this]", start: 0, end: 0 },
    };
    expect(mediaRefs(cloze)).toEqual(["a.png"]);
  });

  it("ignores links, URLs, titles, and files that are not media", () => {
    const card = basic(
      '[not an image](b.png) ![](https://x.y/c.png) ![](d.png "a title") ![](notes.pdf)'
    );
    expect(mediaRefs(card)).toEqual(["aws/d.png"]);
  });

  it("reads an angle-bracketed path with spaces", () => {
    expect(mediaRefs(basic("![](<my diagram.png>)"))).toEqual(["aws/my diagram.png"]);
  });
});
