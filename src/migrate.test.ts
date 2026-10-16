import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFile } from "./parser";
import { parseFile as parseLog } from "./core/events";
import { replay } from "./core/replay";
import { interval } from "./core/schedule";
import { V1Entry, fuzzWindow, inferSettings, planMigration } from "./migrate";

async function hashes(text: string): Promise<string[]> {
  return (await parseFile(text, "deck.md", "deck")).map((c) => c.hash);
}

function entry(at: string, s: number, reps: number, extra: Partial<V1Entry> = {}): V1Entry {
  // What the v1 app wrote at 90%, fuzz off: an interval equal to stability.
  const days = Math.max(1, Math.round(s));
  const day = new Date(Date.parse(at) + 2 * 3600_000).toISOString().slice(0, 10);
  const due = new Date(Date.parse(day + "T00:00:00Z") + days * 86400_000).toISOString().slice(0, 10);
  return {
    lastReviewedAt: at,
    stability: s,
    difficulty: 5,
    intervalRaw: s,
    intervalDays: days,
    dueDate: due,
    reviewCount: reps,
    ...extra,
  };
}

const state = (cards: Record<string, V1Entry>) => JSON.stringify({ version: 1, cards });
const v1Line = (card: string, at: string, grade: number) =>
  JSON.stringify({ card, at, grade, s: 3, d: 5, ms: 1000 });

const DECK_A = "Q: one\nA: 1\n\n---\n\nC: The [two] and [three].\n";
const DECK_B = "Q: four\nA: 4\n\n---\n\nQ: five\nA: 5\n";

describe("planMigration", () => {
  it("leaves the decks alone, and maps every card's v1 hash to its key", async () => {
    const plan = await planMigration({
      decks: [
        { path: "a.md", text: DECK_A },
        { path: "b.md", text: DECK_B },
      ],
      state: null,
      logs: [],
    });
    expect(plan).not.toHaveProperty("stamped");
    const cards = [...(await parseFile(DECK_A, "a.md", "a")), ...(await parseFile(DECK_B, "b.md", "b"))];
    expect(plan.keysByHash).toEqual(new Map(cards.map((c) => [c.hash, [c.key]])));
  });

  it("turns the state file into baselines and the log into reviews, under the new keys", async () => {
    const [h1, , h3] = await hashes(DECK_A);
    const [k1, , k3] = (await parseFile(DECK_A, "a.md", "a")).map((c) => c.key);
    const at = "2026-10-13T19:14:37.619Z";
    const plan = await planMigration({
      decks: [{ path: "a.md", text: DECK_A }],
      state: state({ [h1]: entry(at, 8.2956, 1), [h3]: entry("2026-01-10T08:00:00.000Z", 3, 4) }),
      logs: [{ path: "hashcards-reviews/2026-10.dev.jsonl", text: v1Line(h1, at, 4) + "\n" }],
    });

    expect([...plan.files.keys()]).toEqual(["reviews/2026-01.v1.jsonl", "reviews/2026-10.v1.jsonl"]);
    const october = parseLog(plan.files.get("reviews/2026-10.v1.jsonl")!).events;
    expect(october).toEqual([
      // No `src` on the review: a device's own copy of it must be the same line.
      { v: 2, kind: "review", card: k1, at, tz: 120, grade: 4, ms: 1000 },
      // The grade comes from the review the baseline was taken at.
      { v: 2, kind: "baseline", card: k1, at, tz: 120, s: 8.2956, d: 5, reps: 1, grade: 4, src: "v1" },
    ]);
    // Winter: CET, made explicit; no review at that instant, so no grade.
    expect(parseLog(plan.files.get("reviews/2026-01.v1.jsonl")!).events).toEqual([
      { v: 2, kind: "baseline", card: k3, at: "2026-01-10T08:00:00.000Z", tz: 60, s: 3, d: 5, reps: 4, src: "v1" },
    ]);
    expect(plan.counts).toMatchObject({ cards: 3, baselines: 2, reviews: 1, unknownHashes: 0 });
  });

  it("files events by the local month they happened in", async () => {
    const [h1] = await hashes(DECK_A);
    // 23:30 UTC on 30 September is 01:30 on 1 October in Berlin.
    const at = "2026-09-30T23:30:00.000Z";
    const plan = await planMigration({
      decks: [{ path: "a.md", text: DECK_A }],
      state: null,
      logs: [{ path: "l.jsonl", text: v1Line(h1, at, 3) + "\n" }],
    });
    expect([...plan.files.keys()]).toEqual(["reviews/2026-10.v1.jsonl"]);
  });

  it("keeps the history of cards no deck has under their h: keys", async () => {
    const gone = "ab".repeat(32);
    const plan = await planMigration({
      decks: [{ path: "a.md", text: DECK_A }],
      state: state({ [gone]: entry("2026-10-01T08:00:00.000Z", 5, 2) }),
      logs: [{ path: "l.jsonl", text: v1Line(gone, "2026-10-01T08:00:00.000Z", 3) + "\n" }],
    });
    expect(plan.counts).toMatchObject({ unknownHashes: 1, unknownBaselines: 1, unknownReviews: 1, baselines: 0 });
    expect(plan.events.every((e) => e.card === `h:${"ab".repeat(8)}`)).toBe(true);
    expect(plan.check.rows[0]).toMatchObject({ key: `h:${"ab".repeat(8)}`, known: false, verdict: "exact" });
  });

  it("gives two identical cards one key, and its history once", async () => {
    const twice = "Q: same\nA: s\n";
    const [h] = await hashes(twice);
    const plan = await planMigration({
      decks: [
        { path: "a.md", text: twice },
        { path: "b.md", text: twice },
      ],
      state: state({ [h]: entry("2026-10-01T08:00:00.000Z", 5, 2) }),
      logs: [],
    });
    const [card] = await parseFile(twice, "a.md", "a");
    expect(plan.events.map((e) => e.card)).toEqual([card.key]);
  });

  it("reports and skips state entries it cannot read", async () => {
    const plan = await planMigration({
      decks: [],
      state: JSON.stringify({ cards: { ["cd".repeat(32)]: { stability: 0 } } }),
      logs: [{ path: "l.jsonl", text: "{not json\n" }],
    });
    expect(plan.events).toEqual([]);
    expect(plan.warnings).toEqual([
      "hashcards-state.json: entry cdcdcdcdcdcdcdcd is incomplete and was skipped",
      "l.jsonl:1: not valid JSON",
    ]);
  });
});

describe("the before/after check", () => {
  async function check(e: V1Entry, log: string[] = []) {
    const [h1] = await hashes(DECK_A);
    const plan = await planMigration({
      decks: [{ path: "a.md", text: DECK_A }],
      state: state({ [h1]: e }),
      logs: [{ path: "l.jsonl", text: log.map((at) => v1Line(h1, at, 3)).join("\n") + "\n" }],
    });
    return plan.check.rows[0];
  }

  const AT = "2026-10-01T08:00:00.000Z";

  it("is exact when replay lands on the state file's due date", async () => {
    // Fuzz is on by default, and leaves an interval under 3 days alone.
    expect(await check(entry(AT, 2, 3))).toMatchObject({ verdict: "exact", dueDelta: 0 });
  });

  it("accepts a due date anywhere fuzz could have put it", async () => {
    const e = entry(AT, 40, 3);
    const row = await check({ ...e, dueDate: "2026-11-12", intervalDays: 42 });
    // 40 days ± 2: the state file's 42 is inside, wherever replay's seed lands.
    expect(fuzzWindow(40, 3)).toEqual([38, 42]);
    expect(["exact", "fuzz"]).toContain(row.verdict);
    expect(row.after!.s).toBe(40);
  });

  it("flags a due date fuzz cannot explain", async () => {
    const row = await check({ ...entry(AT, 40, 3), dueDate: "2026-12-25" });
    expect(row).toMatchObject({ verdict: "other" });
    expect(row.why).toContain("outside fuzz");
  });

  it("explains a card the log has newer reviews of", async () => {
    const row = await check(entry(AT, 10, 3), ["2026-10-05T08:00:00.000Z"]);
    expect(row).toMatchObject({ verdict: "newer" });
    expect(row.after!.reps).toBe(4);
  });

  it("explains the v1 rules since dropped: the 256-day cap and same-day passes", async () => {
    const capped = await check({ ...entry(AT, 400, 9), intervalDays: 256, dueDate: "2027-06-14" });
    expect(capped).toMatchObject({ verdict: "rules" });
    const sameDay = await check({ ...entry(AT, 0.3, 2), intervalDays: 0, dueDate: "2026-10-01" });
    expect(sameDay).toMatchObject({ verdict: "rules" });
  });

  it("explains a card scheduled at another retention", async () => {
    // Scheduled at 0.85 in March; every other card (none here) says 0.9.
    const s = 20;
    const raw = interval(0.85, s);
    const e = entry(AT, s, 3, { intervalRaw: raw, intervalDays: Math.round(raw) });
    const [h1] = await hashes(DECK_A);
    // 38 days at 85%, where 90% gives 20.
    expect(Math.round(raw)).toBe(38);
    const plan = await planMigration(
      { decks: [{ path: "a.md", text: DECK_A }], state: state({ [h1]: { ...e, dueDate: "2026-11-08" } }), logs: [] },
      { retention: 0.9 }
    );
    expect(plan.check.rows[0]).toMatchObject({ verdict: "retention" });
  });
});

describe("inferSettings", () => {
  it("reads retention off the latest card's raw interval", () => {
    const s = 10;
    const entries = new Map([
      ["a", entry("2026-01-01T00:00:00.000Z", s, 1)],
      ["b", entry("2026-02-01T00:00:00.000Z", s, 1, { intervalRaw: interval(0.85, s) })],
    ]);
    expect(inferSettings(entries).retention).toMatchObject({ value: 0.85, source: "state file" });
  });

  it("says fuzz was on when any interval moved, off when many did not", () => {
    const on = new Map([["a", entry("2026-01-01T00:00:00.000Z", 10, 1, { intervalDays: 11 })]]);
    expect(inferSettings(on).fuzz).toMatchObject({ value: true, source: "state file" });
    const off = new Map(
      [5, 6, 7, 8, 9].map((s, i) => [String(i), entry("2026-01-01T00:00:00.000Z", s, 1)] as const)
    );
    expect(inferSettings(off).fuzz).toMatchObject({ value: false, source: "state file" });
    expect(inferSettings(new Map()).fuzz).toMatchObject({ value: true, source: "default" });
  });
});

describe("the v1 fixture repo (my-hashcards)", () => {
  const root = new URL("../cli/fixtures/v1-repo/", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");
  const decks = [
    "geography/europe/Europe_Central.md",
    "geography/europe/Europe_Nordic_Baltic.md",
    "geography/europe/Europe_Southern.md",
    "geography/europe/Europe_Western.md",
    "geography/germany/Germany_States.md",
    "geography/norway/Norway_Counties.md",
  ];
  const input = () => ({
    decks: decks.map((path) => ({ path, text: read(path) })),
    state: read("hashcards-state.json"),
    logs: readdirSync(new URL("hashcards-reviews/", root)).map((name) => ({
      path: `hashcards-reviews/${name}`,
      text: read(`hashcards-reviews/${name}`),
    })),
  });

  it("migrates every card with nothing the check cannot explain", async () => {
    const plan = await planMigration(input());
    expect(plan.counts).toEqual({
      cards: 240,
      baselines: 51,
      reviews: 58,
      unknownHashes: 87,
      unknownBaselines: 87,
      unknownReviews: 2,
    });
    expect(plan.settings.retention.value).toBe(0.9);
    expect(plan.settings.fuzz.value).toBe(true);
    const { rows, ...verdicts } = plan.check;
    expect(verdicts.other).toBe(0);
    expect(verdicts.newer).toBe(0);
    // The only rule changes are on archived cards, which no deck shows.
    expect(rows.filter((r) => r.verdict === "rules").every((r) => !r.known)).toBe(true);
    // Every card in a deck keeps its memory state exactly.
    for (const row of rows.filter((r) => r.known)) {
      expect(row.after).toMatchObject({ s: row.before.s, d: row.before.d, reps: row.before.reps });
    }
  });

  it("replays the written files to the same states as the events it reports", async () => {
    const plan = await planMigration(input());
    const fromFiles = [...plan.files.values()].flatMap((text) => parseLog(text).events);
    expect(fromFiles).toHaveLength(plan.events.length);
    expect(replay(fromFiles, { fuzz: true })).toEqual(replay(plan.events, { fuzz: true }));
  });

  it("moves no card's due date by more than fuzz, for the app and hc due", async () => {
    const plan = await planMigration(input());
    expect(plan.dueShift.same + plan.dueShift.moved.length).toBe(51);
    for (const m of plan.dueShift.moved) {
      const days = Math.abs(Date.parse(m.after) - Date.parse(m.before)) / 86400_000;
      expect(days).toBeLessThanOrEqual(2);
    }
  });
});
