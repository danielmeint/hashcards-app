import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PARAMETERS,
  addDays,
  dayAt,
  daysBetween,
  fuzzInterval,
  fuzzSeed,
  schedule,
  seededUnit,
  step,
} from "./schedule";

describe("dayAt", () => {
  it("is the calendar day at the given offset, not the machine's", () => {
    // 22:30 UTC on the 13th: the 14th in Berlin's summer, still the 13th in
    // New York, and the 14th already well under way in Auckland.
    expect(dayAt("2026-10-13T22:30:00Z", 120)).toBe("2026-10-14");
    expect(dayAt("2026-10-13T22:30:00Z", -240)).toBe("2026-10-13");
    expect(dayAt("2026-10-13T22:30:00Z", 780)).toBe("2026-10-14");
    expect(dayAt("2026-10-13T22:30:00Z", 0)).toBe("2026-10-13");
  });

  it("reads an instant written with its own offset as that instant", () => {
    expect(dayAt("2026-10-14T00:30:00+02:00", 120)).toBe("2026-10-14");
    expect(dayAt("2026-10-14T00:30:00+02:00", 0)).toBe("2026-10-13");
  });

  it("does not change with the process's TZ", () => {
    const saved = process.env.TZ;
    try {
      const days = ["UTC", "Pacific/Auckland", "America/Los_Angeles"].map((tz) => {
        process.env.TZ = tz;
        return dayAt("2026-03-29T00:30:00Z", 60);
      });
      expect(new Set(days)).toEqual(new Set(["2026-03-29"]));
    } finally {
      process.env.TZ = saved;
    }
  });
});

describe("day arithmetic", () => {
  it("counts whole days across month ends and DST changes", () => {
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });
});

describe("deterministic fuzz", () => {
  it("is a function of the seed alone", () => {
    expect(seededUnit(fuzzSeed("est-capital", 4))).toBe(seededUnit(fuzzSeed("est-capital", 4)));
    expect(seededUnit("a")).not.toBe(seededUnit("b"));
  });

  it("stays in [0, 1) and spreads neighbouring seeds out", () => {
    const units = Array.from({ length: 2000 }, (_, i) => seededUnit(fuzzSeed("card", i)));
    expect(Math.min(...units)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...units)).toBeLessThan(1);
    // Ten buckets, each near a tenth: a seed's last digit must not decide it.
    const buckets = Array(10).fill(0);
    for (const u of units) buckets[Math.floor(u * 10)]++;
    for (const n of buckets) expect(n).toBeGreaterThan(150);
  });

  it("keeps the ±5% shape, and leaves short intervals alone", () => {
    expect(fuzzInterval(2, 0)).toBe(2);
    expect(fuzzInterval(2, 0.99)).toBe(2);
    // Under 20 days the spread is a day either way.
    expect(fuzzInterval(10, 0)).toBe(9);
    expect(fuzzInterval(10, 0.5)).toBe(10);
    expect(fuzzInterval(10, 0.999)).toBe(11);
    // 200 days: ±10.
    expect(fuzzInterval(200, 0)).toBe(190);
    expect(fuzzInterval(200, 0.999)).toBe(210);
  });

  it("gives every outcome in the range for some seed", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      seen.add(schedule(100, 3, "2026-01-01", i, { fuzz: true, key: "k" }).intervalDays);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([
      95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105,
    ]);
  });

  it("is seeded by the key and the review count, so a step repeats exactly", () => {
    const prior = { stability: 40, difficulty: 5, lastDay: "2026-01-01", reviewCount: 6 };
    const run = () => step(prior, 3, "2026-02-10", { fuzz: true, key: "est-capital" });
    expect(run()).toEqual(run());
  });

  describe("without a key", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("falls back to Math.random, as the live path did", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      expect(schedule(100, 3, "2026-01-01", 1, { fuzz: true }).intervalDays).toBe(95);
      expect(random).toHaveBeenCalledTimes(1);
    });

    it("does not draw when fuzz is off", () => {
      const random = vi.spyOn(Math, "random");
      schedule(100, 3, "2026-01-01", 1, { key: "k" });
      schedule(100, 3, "2026-01-01", 1);
      expect(random).not.toHaveBeenCalled();
    });
  });
});

describe("schedule", () => {
  it("keeps a lapse due the same day, and puts a pass a day out", () => {
    expect(schedule(0.2, 1, "2026-04-02", 1).dueDate).toBe("2026-04-02");
    expect(schedule(0.2, 3, "2026-04-02", 1).dueDate).toBe("2026-04-03");
    // A baseline that never recorded its grade is read as a pass.
    expect(schedule(0.2, null, "2026-04-02", 1).dueDate).toBe("2026-04-03");
  });

  it("takes fitted parameters", () => {
    // A steeper decay (w20) shortens every interval past S at 80%.
    const steep = [...PARAMETERS];
    steep[20] = 0.5;
    expect(schedule(30, 3, "2026-01-01", 1, { retention: 0.8, params: steep }).intervalRaw).toBeLessThan(
      schedule(30, 3, "2026-01-01", 1, { retention: 0.8 }).intervalRaw
    );
  });
});
