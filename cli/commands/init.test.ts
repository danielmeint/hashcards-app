import { describe, expect, it } from "vitest";
import { parseConfig } from "../config";
import { hc, makeRepo, read, write } from "../test-helpers";

describe("hc init", () => {
  it("writes hashcards.toml, AGENTS.md and the lint workflow", async () => {
    const repo = makeRepo({ "CARD_GUIDE.md": "# guide\n", "deck.md": "Q: q\nA: a\n" });
    const run = await hc(["init", "--json", "--repo", repo]);
    expect(run.code).toBe(0);
    expect(run.json()).toEqual({
      written: ["hashcards.toml", "AGENTS.md", ".github/workflows/hashcards-lint.yml"],
      skipped: [],
    });
    const { config, problems } = parseConfig(read(repo, "hashcards.toml"));
    expect(problems).toEqual([]);
    // Today's documentation stays out of the decks once [decks] is written.
    expect(config.decks!.exclude).toEqual(["README.md", "AGENTS.md", "CLAUDE.md", "CARD_GUIDE.md"]);
    expect(read(repo, "AGENTS.md")).toContain("Status: draft");
    expect(read(repo, ".github/workflows/hashcards-lint.yml")).toContain("hashcards lint");
    // And the result lints clean: AGENTS.md is not a deck.
    expect((await hc(["lint", "--json", "--repo", repo])).json()).toMatchObject({ ok: true, files: 1 });
  });

  it("never overwrites an existing file without --force", async () => {
    const repo = makeRepo({ "AGENTS.md": "mine\n", "hashcards.toml": "[review]\nnew_per_day = 5\n" });
    const run = await hc(["init", "--json", "--repo", repo]);
    expect(run.json()).toEqual({
      written: [".github/workflows/hashcards-lint.yml"],
      skipped: ["hashcards.toml", "AGENTS.md"],
    });
    expect(read(repo, "AGENTS.md")).toBe("mine\n");
    expect(read(repo, "hashcards.toml")).toBe("[review]\nnew_per_day = 5\n");
    const human = await hc(["init", "--repo", repo]);
    expect(human.stdout).toContain("skipped AGENTS.md: exists (--force to overwrite)");

    write(repo, "AGENTS.md", "mine\n");
    const forced = await hc(["init", "--force", "--json", "--repo", repo]);
    expect(forced.json().skipped).toEqual([]);
    expect(read(repo, "AGENTS.md")).not.toBe("mine\n");
  });
});

describe("later milestones", () => {
  it.each([["fit"]])("hc %s is a stub that says where it is planned", async (...argv) => {
    const run = await hc([...argv, "--repo", makeRepo()]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/not implemented yet, see PLAN-1\.0\.md M7/);
  });
});
