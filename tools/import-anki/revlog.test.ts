import { describe, expect, it } from "vitest";
import {
  addDays,
  ankiDue,
  capMs,
  checkScheduler,
  classifyRevlog,
  dayZero,
  localDate,
  localMonth,
  toEvent,
  tzOffsetMinutes,
} from "./revlog.ts";

const BERLIN = "Europe/Berlin";

describe("classifyRevlog", () => {
  it("imports learn, review and relearn answers with ease as the grade", () => {
    for (const type of [0, 1, 2]) {
      for (const ease of [1, 2, 3, 4]) {
        expect(classifyRevlog({ type, ease, factor: 2500 })).toEqual({ grade: ease });
      }
    }
  });

  it("keeps filtered-deck reviews that rescheduled, skips cram", () => {
    expect(classifyRevlog({ type: 3, ease: 3, factor: 2500 })).toEqual({ grade: 3 });
    expect(classifyRevlog({ type: 3, ease: 3, factor: 0 })).toEqual({
      skip: "cram (filtered deck without rescheduling)",
    });
  });

  it("skips manual, rescheduled, non-answers and unknown types", () => {
    expect(classifyRevlog({ type: 4, ease: 0, factor: 0 })).toEqual({ skip: "manual (set due date / forget)" });
    expect(classifyRevlog({ type: 5, ease: 0, factor: 0 })).toEqual({ skip: "rescheduled" });
    expect(classifyRevlog({ type: 1, ease: 0, factor: 2500 })).toEqual({ skip: "not an answer (ease 0)" });
    expect(classifyRevlog({ type: 9, ease: 3, factor: 2500 })).toEqual({ skip: "unknown revlog type" });
  });

  it("refuses the v1 scheduler only", () => {
    expect(checkScheduler(1)).toMatch(/v1 scheduler/);
    expect(checkScheduler(2)).toBeNull();
    expect(checkScheduler(null)).toBeNull();
  });

  it("caps time", () => {
    expect(capMs(9100)).toBe(9100);
    expect(capMs(600_000)).toBe(60_000);
    expect(capMs(600_000, 120_000)).toBe(120_000);
    expect(capMs(-5)).toBe(0);
  });
});

describe("time zones", () => {
  it("derives the offset per instant, across both DST switches", () => {
    // 2026: CEST from 29 March 01:00 UTC to 25 October 01:00 UTC.
    expect(tzOffsetMinutes(Date.parse("2026-03-29T00:59:59Z"), BERLIN)).toBe(60);
    expect(tzOffsetMinutes(Date.parse("2026-03-29T01:00:00Z"), BERLIN)).toBe(120);
    expect(tzOffsetMinutes(Date.parse("2026-10-25T00:59:59Z"), BERLIN)).toBe(120);
    expect(tzOffsetMinutes(Date.parse("2026-10-25T01:00:00Z"), BERLIN)).toBe(60);
  });

  it("handles UTC and negative and half-hour zones", () => {
    expect(tzOffsetMinutes(0, "UTC")).toBe(0);
    expect(tzOffsetMinutes(Date.parse("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(tzOffsetMinutes(Date.parse("2026-01-15T12:00:00Z"), "Asia/Kolkata")).toBe(330);
  });

  it("files a review by its local month and date", () => {
    // 23:30 on 31 August in Berlin.
    const lateAugust = Date.parse("2026-08-31T21:30:00Z");
    expect(localMonth(lateAugust, 120)).toBe("2026-08");
    // 00:30 on 1 September in Berlin is September, though UTC still says August.
    const earlySeptember = Date.parse("2026-08-31T22:30:00Z");
    expect(localMonth(earlySeptember, 120)).toBe("2026-09");
    expect(localDate(earlySeptember, 120)).toBe("2026-09-01");
  });

  it("builds an event with fixed key order", () => {
    const e = toEvent({ id: Date.parse("2026-09-02T18:01:44Z"), time: 9100 }, "cka-wl-set-image", 1, BERLIN);
    expect(JSON.stringify(e)).toBe(
      '{"v":2,"card":"cka-wl-set-image","at":"2026-09-02T18:01:44.000Z","tz":120,"grade":1,"ms":9100,"src":"anki"}'
    );
  });
});

describe("Anki due dates", () => {
  // The real collection: created 2026-02-15 04:00 CET, rollover at 4.
  const crt = Date.parse("2026-02-15T03:00:00Z") / 1000;

  it("finds day 0 from crt and the rollover", () => {
    expect(dayZero(crt, 4, BERLIN)).toBe("2026-02-15");
    expect(addDays("2026-02-15", 238)).toBe("2026-10-11");
  });

  it("reads review due as a day number", () => {
    const card = { type: 2, queue: 2, due: 238, odue: 0, odid: 0 };
    expect(ankiDue(card, crt, 4, BERLIN)).toEqual({ kind: "day", date: "2026-10-11" });
  });

  it("reads intraday learning due as a timestamp", () => {
    const due = Date.parse("2026-10-01T17:52:28Z") / 1000;
    const card = { type: 3, queue: 1, due, odue: 0, odid: 0 };
    expect(ankiDue(card, crt, 4, BERLIN)).toEqual({ kind: "time", at: "2026-10-01T17:52:28.000Z", date: "2026-10-01" });
  });

  it("reads new cards as a position and filtered cards from odue", () => {
    expect(ankiDue({ type: 0, queue: 0, due: 164, odue: 0, odid: 0 }, crt, 4, BERLIN)).toEqual({
      kind: "new",
      position: 164,
    });
    expect(ankiDue({ type: 2, queue: 2, due: -100000, odue: 238, odid: 7 }, crt, 4, BERLIN)).toEqual({
      kind: "day",
      date: "2026-10-11",
    });
  });
});
