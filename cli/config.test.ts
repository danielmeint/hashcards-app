import { describe, expect, it } from "vitest";
import { parseToml } from "./toml";
import { parseConfig, renderConfig } from "./config";
import { parseConfig as parseInApp } from "../src/collection-config";
import { globMatch } from "../src/core/glob";

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

  it("reads dotted table names whole, in file order", () => {
    const doc = parseToml('[limits.b]\nx = 1\n[limits.a]\nx = 2\n');
    expect(Object.keys(doc)).toEqual(["", "limits.b", "limits.a"]);
    expect(doc["limits.a"]).toEqual({ x: 2 });
    expect(() => parseToml("[limits.a]\n[limits.a]")).toThrow(/defined twice \(line 2\)/);
    expect(() => parseToml('[limits."my group"]')).toThrow(/line 1/);
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
    expect(config).toEqual({ review: { newPerDay: 20, desiredRetention: 0.9, fuzz: true }, decks: null, limits: [] });
  });

  it("keeps the default and reports a value out of range", () => {
    const { config, problems } = parseConfig("[review]\ndesired_retention = 0.5\nnew_per_day = -1");
    expect(config.review).toEqual({ newPerDay: 20, desiredRetention: 0.9, fuzz: true });
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/new_per_day/),
      expect.stringMatching(/desired_retention/),
    ]);
  });

  it("reads new-card groups in file order", () => {
    const { config, problems } = parseConfig(`
[limits.interview]
decks = ["interview/**"]
new_per_day = 5

[limits.languages]
decks = ["lang/**", "Spanish.md"]
new_per_day = 10
`);
    expect(problems).toEqual([]);
    expect(config.limits).toEqual([
      { name: "interview", decks: ["interview/**"], newPerDay: 5 },
      { name: "languages", decks: ["lang/**", "Spanish.md"], newPerDay: 10 },
    ]);
  });

  it("reports a new-card group it cannot use, and leaves it out", () => {
    const { config, problems } = parseConfig(`
[limits]
new_per_day = 3

[limits.typo]
decks = ["a/**"]
new_per_dya = 5

[limits.half]
decks = ["b/**"]
new_per_day = 2.5

[limits.globs]
decks = ["c/", "{d,e/*.md", ""]
new_per_day = 3

[limits.none]
decks = []
new_per_day = 3

[limits.fine]
decks = ["f/**"]
new_per_day = 0
extra = "reported, but the group stands"
`);
    expect(config.limits).toEqual([{ name: "fine", decks: ["f/**"], newPerDay: 0 }]);
    expect(problems.map((p) => p.message)).toEqual([
      "[limits] holds no keys of its own: each group is a table, [limits.<name>]",
      "[limits.typo] has no key 'new_per_dya': only decks and new_per_day",
      "[limits.typo] needs new_per_day, a whole number ≥ 0",
      "[limits.half] new_per_day must be a whole number ≥ 0, got 2.5",
      "[limits.globs] decks: 'c/' ends with '/' and matches no file: 'c/**' is everything in it",
      "[limits.globs] decks: '{d,e/*.md' has a '{' with no '}'",
      "[limits.globs] decks: an empty glob matches nothing",
      '[limits.none] decks must be a non-empty array of glob strings, got []',
      "[limits.fine] has no key 'extra': only decks and new_per_day",
    ]);
  });

  it("reads the same groups as the app does, broken ones left out by both", () => {
    const texts = [
      '[limits.a]\ndecks = ["a/**"]\nnew_per_day = 1\n[limits.b]\ndecks = ["{b,c}/*.md", "README.md"]\nnew_per_day = 0\n',
      '[limits.a]\ndecks = ["a/"]\nnew_per_day = 1\n[limits.b]\ndecks = ["b/**"]\nnew_per_day = -1\n',
      '[limits.a]\ndecks = "a/**"\nnew_per_day = 1\n[limits.ok]\nnew_per_day = 2\ndecks = ["x/**"] # order of keys\n',
    ];
    for (const text of texts) expect(parseConfig(text).config.limits).toEqual(parseInApp(text).limits);
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
    expect(globMatch(pattern, path)).toBe(want);
  });
});
