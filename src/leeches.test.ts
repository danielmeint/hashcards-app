import { describe, it, expect } from "vitest";
import { Card, Grade, Review } from "./types";
import { cardSummary, findLeeches, isRecovering } from "./leeches";

/**
 * The review log has only ever been aggregated — counts, retention, a heatmap.
 * These cover pulling the one actionable thing out of it: the specific cards
 * that keep failing, which are almost always badly written rather than hard.
 */

function basic(hash: string, question = `Q ${hash}`): Card {
  return {
    deckName: "Test",
    filePath: "test.md",
    range: [1, 2],
    content: { type: "basic", question, answer: "A" },
    hash,
    familyHash: null,
  };
}

let clock = 0;
function review(cardHash: string, grade: Grade): Review {
  clock += 1;
  return {
    cardHash,
    reviewedAt: new Date(Date.UTC(2026, 0, clock)).toISOString(),
    grade,
    stability: 2,
    difficulty: 6,
    intervalRaw: 2,
    intervalDays: 2,
    dueDate: "2026-02-01",
  };
}

const F = Grade.Forgot;
const G = Grade.Good;

/** A card's history, oldest first. */
function history(hash: string, grades: Grade[]): Review[] {
  return grades.map((g) => review(hash, g));
}

describe("finding leeches", () => {
  it("ignores a card that fails less often than the threshold", () => {
    const leeches = findLeeches([basic("a")], history("a", [F, G, F, G]));
    expect(leeches).toEqual([]);
  });

  it("counts only Forgot as a failure", () => {
    // Hard requeues the card for reinforcement, but FSRS scores it as a
    // success — counting it would flag every card you ever found effortful.
    const leeches = findLeeches(
      [basic("a")],
      history("a", [Grade.Hard, Grade.Hard, Grade.Hard, Grade.Hard])
    );
    expect(leeches).toEqual([]);
  });

  it("reports lapses against the number of reviews", () => {
    const [leech] = findLeeches([basic("a")], history("a", [F, G, F, G, F]));
    expect(leech).toMatchObject({ lapses: 3, reviews: 5, streak: 0 });
  });

  it("puts the worst card first", () => {
    const leeches = findLeeches(
      [basic("a"), basic("b")],
      [...history("a", [F, F, F]), ...history("b", [F, F, F, F, F])]
    );
    expect(leeches.map((l) => l.card.hash)).toEqual(["b", "a"]);
  });

  it("breaks a tie on lapses by how often the card fails", () => {
    const leeches = findLeeches(
      [basic("a"), basic("b")],
      [
        // Three lapses in twenty reviews is a card you mostly know.
        ...history("a", [F, F, F, G, G, G, G, G, G, G, G, G]),
        ...history("b", [F, F, F, G]),
      ]
    );
    expect(leeches.map((l) => l.card.hash)).toEqual(["b", "a"]);
  });

  it("sorts a card that has since stuck to the bottom", () => {
    const leeches = findLeeches(
      [basic("struggling"), basic("recovered")],
      [
        ...history("struggling", [F, F, F]),
        // More lapses, but answered correctly every time since.
        ...history("recovered", [F, F, F, F, F, G, G, G]),
      ]
    );
    expect(leeches.map((l) => l.card.hash)).toEqual([
      "struggling",
      "recovered",
    ]);
    expect(isRecovering(leeches[0])).toBe(false);
    expect(isRecovering(leeches[1])).toBe(true);
  });

  it("measures the streak from the last lapse, not from the first", () => {
    const [leech] = findLeeches([basic("a")], history("a", [F, G, G, F, F, G]));
    // Counting from the first lapse would call this a streak of four.
    expect(leech.streak).toBe(1);
  });

  it("ignores history belonging to a card that no longer exists", () => {
    // Editing a card gives it a new hash, and the old scheduling is kept
    // rather than deleted (roadmap 1.7). There is nothing left to rewrite.
    const leeches = findLeeches([basic("current")], history("edited-away", [F, F, F, F]));
    expect(leeches).toEqual([]);
  });

  it("reads history in time order even when the log is not", () => {
    const shuffled = history("a", [F, G, F, F, G, G]).reverse();
    const [leech] = findLeeches([basic("a")], shuffled);
    // Two reviews since the last lapse, whichever order they were stored in.
    expect(leech.streak).toBe(2);
  });
});

describe("identifying a card in a list", () => {
  it("shows a basic card's question on one line", () => {
    const card = basic("a", "What is\n  the  speed of light?");
    expect(cardSummary(card)).toBe("What is the speed of light?");
  });

  it("shows a cloze sentence with the deletion marked", () => {
    const text = "Light travels at 300,000 km/s in a vacuum.";
    const start = new TextEncoder().encode("Light travels at ").length;
    const end = start + new TextEncoder().encode("300,000 km/s").length - 1;
    const card: Card = {
      ...basic("c"),
      content: { type: "cloze", text, start, end },
    };
    // The sentence is what you would be rewriting, so the sentence is shown.
    expect(cardSummary(card)).toBe("Light travels at […] in a vacuum.");
  });

  it("splices a cloze by byte, so multi-byte text survives", () => {
    const text = "Die Größe ist wichtig.";
    const start = new TextEncoder().encode("Die ").length;
    const end = start + new TextEncoder().encode("Größe").length - 1;
    const card: Card = {
      ...basic("c"),
      content: { type: "cloze", text, start, end },
    };
    expect(cardSummary(card)).toBe("Die […] ist wichtig.");
  });
});
