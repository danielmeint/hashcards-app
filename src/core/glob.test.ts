import { describe, expect, it } from "vitest";
import { globMatch, globProblem } from "./glob";

/**
 * The app and `hc` both match through this one function, so a glob in
 * hashcards.toml picks the same decks on a phone and in CI.
 */
describe("globs", () => {
  it.each([
    // No slash: the file name, at any depth.
    ["README.md", "README.md", true],
    ["README.md", "docs/README.md", true],
    ["*.md", "a/b.md", true],
    // A slash anchors it at the root; a leading one says the same.
    ["docs/README.md", "README.md", false],
    ["/README.md", "README.md", true],
    ["/README.md", "docs/README.md", false],
    ["a/*.md", "a/x/b.md", false],
    // ** as a segment is any number of folders, none included.
    ["**/*.md", "c.md", true],
    ["**/*.md", "a/b/c.md", true],
    ["interview/**", "interview/sd/caching.md", true],
    ["interview/**", "interview.md", false],
    ["interview/**", "interviews/x.md", false],
    ["cka/**/drills.md", "cka/drills.md", true],
    ["cka/**/drills.md", "cka/a/b/drills.md", true],
    // Anywhere else it is a *, as in .gitignore.
    ["cka**", "cka-notes.md", true],
    ["cka**", "cka/x.md", false],
    // Braces: either alternative, and the slash in the pattern anchors both.
    ["{cka,geo}/*.md", "cka/x.md", true],
    ["{cka,geo}/*.md", "k8s/x.md", false],
    ["{cka,geo}/*.md", "deep/cka/x.md", false],
    ["{README,CHANGELOG}.md", "docs/CHANGELOG.md", true],
    ["lang/{es,{de,fr}}/*.md", "lang/fr/verbs.md", true],
    // Everything else is itself.
    ["a+b.md", "a+b.md", true],
    ["a+b.md", "aab.md", false],
    ["[x].md", "[x].md", true],
    ["{open.md", "{open.md", true],
  ])("%s ~ %s is %s", (pattern, path, want) => {
    expect(globMatch(pattern, path)).toBe(want);
  });

  it("names a glob that can never match", () => {
    expect(globProblem("interview/**")).toBeNull();
    expect(globProblem("{a,b}/*.md")).toBeNull();
    expect(globProblem("")).toMatch(/empty/);
    expect(globProblem("{a,b/*.md")).toMatch(/'\{' with no '\}'/);
    expect(globProblem("a}.md")).toMatch(/'\}' with no '\{'/);
    expect(globProblem("interview/")).toMatch(/'interview\/\*\*' is everything in it/);
  });
});
