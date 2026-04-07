import { Card, Performance, ReviewedPerformance } from "./types";
import { parseFile } from "./parser";
import { todayStr } from "./fsrs";

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A real markdown deck exercising the full parser: frontmatter, Q/A, cloze,
// multi-line content, cloze siblings, markdown formatting.
const DEMO_DECK = `\
---
name = "Demo Deck"
---

Q: What is the capital of Japan?
A: Tokyo

---

Q: What is the capital of Australia?
A: Canberra

---

Q: What is the capital of Brazil?
A: Brasília

---

C: The powerhouse of the cell is the [mitochondria].

---

C: DNA replication occurs during the [S phase] of the cell cycle.

---

Q: State the quadratic formula for solving \`ax² + bx + c = 0\`.
A: x = (−b ± √(b² − 4ac)) / 2a

The discriminant \`b² − 4ac\` determines the number of real solutions.

---

Q: What is Euler's identity?
A: $e^{i\\pi} + 1 = 0$

Connects five fundamental constants: *e*, *i*, *π*, 1, and 0.

---

C: [Ephemeral] means [lasting for a very short time].

---

Q: Define *ubiquitous*.
A: Present, appearing, or found everywhere.
`;

// Performance templates applied to cards by index to simulate diverse SRS states.
// Cards not listed here stay as "new".
const PERF_TEMPLATES: Record<number, (today: string) => ReviewedPerformance> = {
  // card 1: young, reviewed yesterday, due today
  1: (today) => ({
    type: "reviewed",
    lastReviewedAt: addDays(today, -1) + "T10:00:00Z",
    stability: 1.18,
    difficulty: 6.5,
    intervalRaw: 1.1,
    intervalDays: 1,
    dueDate: today,
    reviewCount: 1,
  }),
  // card 2: mature, reviewed 30 days ago, due today
  2: (today) => ({
    type: "reviewed",
    lastReviewedAt: addDays(today, -30) + "T10:00:00Z",
    stability: 32.5,
    difficulty: 4.2,
    intervalRaw: 30.1,
    intervalDays: 30,
    dueDate: today,
    reviewCount: 8,
  }),
  // card 4: overdue, was due 5 days ago
  4: (today) => ({
    type: "reviewed",
    lastReviewedAt: addDays(today, -12) + "T10:00:00Z",
    stability: 7.0,
    difficulty: 5.8,
    intervalRaw: 7.2,
    intervalDays: 7,
    dueDate: addDays(today, -5),
    reviewCount: 3,
  }),
  // card 5: struggling, low stability
  5: (today) => ({
    type: "reviewed",
    lastReviewedAt: addDays(today, -1) + "T10:00:00Z",
    stability: 0.4,
    difficulty: 8.5,
    intervalRaw: 0.4,
    intervalDays: 1,
    dueDate: today,
    reviewCount: 4,
  }),
  // card 6: easy, high stability
  6: (today) => ({
    type: "reviewed",
    lastReviewedAt: addDays(today, -60) + "T10:00:00Z",
    stability: 65.0,
    difficulty: 2.5,
    intervalRaw: 62.3,
    intervalDays: 60,
    dueDate: today,
    reviewCount: 6,
  }),
  // card 7: recently learned (first cloze sibling)
  7: (today) => ({
    type: "reviewed",
    lastReviewedAt: addDays(today, -3) + "T10:00:00Z",
    stability: 3.2,
    difficulty: 5.3,
    intervalRaw: 3.1,
    intervalDays: 3,
    dueDate: today,
    reviewCount: 1,
  }),
};

export async function getDemoData(): Promise<{
  cards: Card[];
  cache: Map<string, Performance>;
}> {
  const cards = await parseFile(DEMO_DECK, "demo.md", "Demo Deck");
  const today = todayStr();
  const cache = new Map<string, Performance>();

  for (let i = 0; i < cards.length; i++) {
    const template = PERF_TEMPLATES[i];
    cache.set(cards[i].hash, template ? template(today) : { type: "new" });
  }

  return { cards, cache };
}
