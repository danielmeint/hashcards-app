import { describe, it, expect } from "vitest";
import { globMatch, isDeckPath, parseConfig, writeReviewConfig } from "./collection-config";

const FULL = `# Collection settings
[review]
new_per_day = 20
desired_retention = 0.9     # 0.80–0.95
fuzz = true

[decks]
include = ["**/*.md"]
exclude = [
  "README.md",   # every README
  "AGENTS.md",
  "archive/**",
]

[something_else]
kept = "as it is"
`;

describe("reading hashcards.toml", () => {
  it("reads every documented key", () => {
    expect(parseConfig(FULL)).toEqual({
      review: { newPerDay: 20, desiredRetention: 0.9, fuzz: true },
      decks: { include: ["**/*.md"], exclude: ["README.md", "AGENTS.md", "archive/**"] },
    });
  });

  it("reads nothing from an empty or missing file", () => {
    expect(parseConfig("")).toEqual({ review: {}, decks: {} });
  });

  it("ignores a value it cannot use, and keeps the rest", () => {
    const config = parseConfig('[review]\ndesired_retention = 0.5\nnew_per_day = "lots"\nfuzz = false\n');
    expect(config.review).toEqual({ fuzz: false });
  });

  it("does not read a key from the wrong table", () => {
    expect(parseConfig("fuzz = false\n[decks]\nnew_per_day = 3\n").review).toEqual({});
  });

  it("does not mistake a # inside a string for a comment", () => {
    expect(parseConfig('[decks]\nexclude = ["notes#1.md"] # a comment\n').decks.exclude).toEqual(["notes#1.md"]);
  });
});

describe("writing hashcards.toml", () => {
  it("round-trips: what it writes reads back as what was written", () => {
    const text = writeReviewConfig(FULL, { newPerDay: 5, desiredRetention: 0.85, fuzz: false });
    expect(parseConfig(text).review).toEqual({ newPerDay: 5, desiredRetention: 0.85, fuzz: false });
    expect(parseConfig(text).decks).toEqual(parseConfig(FULL).decks);
  });

  it("changes only the lines of the keys it sets, comments included", () => {
    const text = writeReviewConfig(FULL, { desiredRetention: 0.85 });
    expect(text).toBe(FULL.replace("desired_retention = 0.9     # 0.80–0.95", "desired_retention = 0.85 # 0.80–0.95"));
  });

  it("is a no-op when the values are already there", () => {
    const once = writeReviewConfig(FULL, { newPerDay: 7 });
    expect(writeReviewConfig(once, { newPerDay: 7 })).toBe(once);
  });

  it("adds a missing key to its table, before the next one", () => {
    const text = writeReviewConfig("[review]\nfuzz = true\n\n[decks]\nexclude = []\n", { newPerDay: 10 });
    expect(text).toBe("[review]\nfuzz = true\nnew_per_day = 10\n\n[decks]\nexclude = []\n");
  });

  it("adds the table when there is none, and makes a file from nothing", () => {
    expect(writeReviewConfig('[decks]\nexclude = ["x/**"]\n', { fuzz: false })).toBe(
      '[decks]\nexclude = ["x/**"]\n\n[review]\nfuzz = false\n'
    );
    expect(writeReviewConfig("", { desiredRetention: 0.9, newPerDay: 20 })).toBe(
      "[review]\nnew_per_day = 20\ndesired_retention = 0.9\n"
    );
  });
});

describe("deck globs", () => {
  it("matches a name without a slash at any depth, and one with a slash from the root", () => {
    expect(globMatch("README.md", "README.md")).toBe(true);
    expect(globMatch("README.md", "docs/README.md")).toBe(true);
    expect(globMatch("docs/README.md", "README.md")).toBe(false);
    expect(globMatch("docs/*.md", "docs/a.md")).toBe(true);
    expect(globMatch("docs/*.md", "docs/deep/a.md")).toBe(false);
  });

  it("reads ** as any number of directories, none included", () => {
    expect(globMatch("**/*.md", "a.md")).toBe(true);
    expect(globMatch("**/*.md", "x/y/a.md")).toBe(true);
    expect(globMatch("archive/**", "archive/2024/old.md")).toBe(true);
    expect(globMatch("archive/**", "archived.md")).toBe(false);
    expect(globMatch("cka/**/drills.md", "cka/drills.md")).toBe(true);
    expect(globMatch("cka/**/drills.md", "cka/a/b/drills.md")).toBe(true);
  });

  it("treats regex characters literally", () => {
    expect(globMatch("a+b.md", "a+b.md")).toBe(true);
    expect(globMatch("a+b.md", "aab.md")).toBe(false);
  });

  it("takes every Markdown file when nothing is configured", () => {
    expect(isDeckPath("x/y.md", {})).toBe(true);
    expect(isDeckPath("x/y.txt", { include: ["**"] })).toBe(false);
  });

  it("excludes after including", () => {
    const decks = { include: ["decks/**"], exclude: ["drafts.md"] };
    expect(isDeckPath("decks/geo.md", decks)).toBe(true);
    expect(isDeckPath("decks/drafts.md", decks)).toBe(false);
    expect(isDeckPath("notes/geo.md", decks)).toBe(false);
  });
});
