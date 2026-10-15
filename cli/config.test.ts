import { describe, expect, it } from "vitest";
import { parseToml } from "./toml";
import { parseConfig, renderConfig } from "./config";
import { matchesGlob } from "./glob";

describe("parseToml", () => {
  it("reads tables, scalars, comments and multi-line arrays", () => {
    const doc = parseToml(`top = 'x' # c
[review]
new_per_day = 1_0
desired_retention = 0.85
fuzz = false
name = "a # not a comment"

[decks]
exclude = [
  "README.md", # docs
  'archive/**',
]`);
    expect(doc[""]).toEqual({ top: "x" });
    expect(doc.review).toEqual({ new_per_day: 10, desired_retention: 0.85, fuzz: false, name: "a # not a comment" });
    expect(doc.decks.exclude).toEqual(["README.md", "archive/**"]);
  });

  it("reports what it cannot read, with the line", () => {
    expect(() => parseToml("[a]\nx = \n")).toThrow(/line 2/);
    expect(() => parseToml("x = 1\nx = 2")).toThrow(/defined twice \(line 2\)/);
    expect(() => parseToml("x = [1, 2")).toThrow(/unclosed array/);
  });
});

describe("parseConfig", () => {
  it("defaults everything that is absent", () => {
    const { config, problems } = parseConfig("");
    expect(problems).toEqual([]);
    expect(config).toEqual({ review: { newPerDay: 20, desiredRetention: 0.9, fuzz: true }, decks: null });
  });

  it("keeps the default and reports a value out of range", () => {
    const { config, problems } = parseConfig("[review]\ndesired_retention = 0.5\nnew_per_day = -1");
    expect(config.review).toEqual({ newPerDay: 20, desiredRetention: 0.9, fuzz: true });
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/new_per_day/),
      expect.stringMatching(/desired_retention/),
    ]);
  });

  it("reads back what `hc init` writes", () => {
    const { config, problems } = parseConfig(renderConfig(["README.md", "CARD_GUIDE.md"]));
    expect(problems).toEqual([]);
    expect(config.decks).toEqual({ include: ["**/*.md"], exclude: ["README.md", "CARD_GUIDE.md"] });
  });
});

describe("globs", () => {
  it.each([
    ["a/b/c.md", "**/*.md", true],
    ["c.md", "**/*.md", true],
    ["a/README.md", "README.md", true],
    ["archive/x/y.md", "archive/**", true],
    ["notarchive/y.md", "archive/**", false],
    ["a/b.md", "*.md", true],
    ["a/b.md", "a/*.md", true],
    ["a/x/b.md", "a/*.md", false],
    ["cka/x.md", "{cka,geo}/*.md", true],
    ["k8s/x.md", "{cka,geo}/*.md", false],
  ])("%s ~ %s is %s", (path, pattern, want) => {
    expect(matchesGlob(path, pattern)).toBe(want);
  });
});
