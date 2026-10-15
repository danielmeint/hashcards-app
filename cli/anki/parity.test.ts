import { describe, expect, it } from "vitest";
import type { ReviewEvent } from "../../src/core/events";
import { replay } from "../../src/core/replay";
import type { ReferenceCard } from "./importer";
import { checkModel, checkParity } from "./parity";

const event = (card: string, at: string, grade: 1 | 2 | 3 | 4): ReviewEvent => ({
  v: 2,
  kind: "review",
  card,
  at,
  tz: 120,
  grade,
  src: "anki",
});

function ref(due: string | null, extra: Partial<ReferenceCard> = {}): ReferenceCard {
  return {
    ankiCardId: 1,
    deck: "Cka",
    state: due === null ? "new" : "review",
    suspended: false,
    buried: false,
    due,
    intervalDays: 0,
    reps: 1,
    lapses: 0,
    fsrs: null,
    ...extra,
  };
}

describe("checkParity", () => {
  const events = [event("a", "2026-10-01T08:00:00.000Z", 3), event("b", "2026-10-01T08:00:00.000Z", 3)];
  const due = replay(events, { fuzz: false }).get("a")!.dueDate;

  it("counts cards within a day, and leaves out new, suspended and unreviewed ones", () => {
    const parity = checkParity(
      events,
      {
        a: ref(due),
        b: ref("2026-11-30"),
        n: ref(null),
        s: ref(due, { suspended: true }),
        x: ref(due),
      },
      { fuzz: false }
    );
    expect(parity).toMatchObject({ compared: 2, withinOneDay: 1, share: 0.5 });
    expect(parity.skipped).toEqual({ new: 1, suspended: 1, noHistory: 1 });
    expect(parity.rows[0].key).toBe("b");
  });

  it("takes fuzz out of both sides when comparing the model", () => {
    const state = replay(events, { fuzz: false }).get("a")!;
    const fsrs = {
      stability: state.stability,
      difficulty: state.difficulty,
      desiredRetention: 0.9,
      decay: 0.1542,
      lastReview: "2026-10-01T08:00:00.000Z",
    };
    // Anki's own due date fuzzed four days out: the model still agrees.
    const model = checkModel(events.slice(0, 1), { a: ref("2026-10-30", { fsrs }) }, 4, () => 120, {});
    expect(model).toMatchObject({ compared: 1, sameStability: 1, withinOneDay: 1 });
  });
});
