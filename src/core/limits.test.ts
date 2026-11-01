import { describe, expect, it } from "vitest";
import { NewCardLimit, budgetFor, limitFor, newCardBudget, pickNew } from "./limits";

const interview: NewCardLimit = { name: "interview", decks: ["interview/**"], newPerDay: 2 };
const lang: NewCardLimit = { name: "lang", decks: ["lang/**", "Spanish.md"], newPerDay: 1 };
const limits = [interview, lang];

describe("new-card groups", () => {
  it("puts a deck in the first group that matches it, or in none", () => {
    expect(limitFor("interview/sd/caching.md", limits)).toBe(interview);
    expect(limitFor("old/Spanish.md", limits)).toBe(lang);
    expect(limitFor("Geography.md", limits)).toBeNull();
    // Two groups match: the first in the file wins.
    const broad: NewCardLimit = { name: "all", decks: ["**/*.md"], newPerDay: 0 };
    expect(limitFor("lang/es.md", [lang, broad])).toBe(lang);
    expect(limitFor("lang/es.md", [broad, lang])).toBe(broad);
  });

  it("spends a group's budget on the cards started in its decks, and the collection's on all of them", () => {
    const budget = newCardBudget(10, limits, ["interview/a.md", "interview/b/c.md", "lang/es.md", "Geo.md", null]);
    expect(budget.total).toBe(5);
    expect(budget.byLimit).toEqual(new Map([["interview", 0], ["lang", 0]]));
    expect(budgetFor("interview/a.md", budget)).toBe(0);
    expect(budgetFor("Geo.md", budget)).toBe(5);
  });

  it("counts a card started in two groups' decks against the first only", () => {
    const broad: NewCardLimit = { name: "all", decks: ["**/*.md"], newPerDay: 3 };
    const budget = newCardBudget(10, [lang, broad], ["lang/es.md"]);
    expect(budget.byLimit).toEqual(new Map([["lang", 0], ["all", 3]]));
  });

  it("holds a group to its own budget within the collection's, and lets other decks fill the rest", () => {
    const unseen = ["interview/1.md", "interview/2.md", "interview/3.md", "lang/1.md", "lang/2.md", "Geo/1.md", "Geo/2.md"];
    const picked = pickNew(unseen, (p) => p, newCardBudget(4, limits, []));
    expect(picked).toEqual(["interview/1.md", "interview/2.md", "lang/1.md", "Geo/1.md"]);
  });

  it("never gives a group more than the collection has left", () => {
    const picked = pickNew(["interview/1.md", "interview/2.md"], (p) => p, newCardBudget(1, limits, []));
    expect(picked).toEqual(["interview/1.md"]);
  });

  it("without groups, is the collection's budget alone", () => {
    const picked = pickNew(["a.md", "b.md", "c.md"], (p) => p, newCardBudget(3, [], ["x.md"]));
    expect(picked).toEqual(["a.md", "b.md"]);
  });
});
