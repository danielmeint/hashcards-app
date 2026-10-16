import { afterEach, describe, expect, it } from "vitest";
import { now, offsetFrom, setClockOffset, skewNotice } from "./clock";

afterEach(() => setClockOffset(0));

describe("offsetFrom", () => {
  const at = Date.parse("2026-10-16T12:00:00.000Z");

  it("leaves a clock within a minute exactly alone", () => {
    expect(offsetFrom("Fri, 16 Oct 2026 12:00:40 GMT", at, at + 200)).toBe(0);
    expect(offsetFrom("Fri, 16 Oct 2026 11:59:20 GMT", at, at + 200)).toBe(0);
  });

  it("measures a device a day fast as a negative offset", () => {
    const fast = at + 26 * 3600_000;
    const offset = offsetFrom("Fri, 16 Oct 2026 12:00:00 GMT", fast, fast + 200)!;
    expect(Math.abs(offset + 26 * 3600_000)).toBeLessThan(1000);
  });

  it("ignores a header it cannot read", () => {
    expect(offsetFrom("not a date", at, at)).toBeNull();
  });
});

describe("now", () => {
  it("is the device clock plus the offset", () => {
    setClockOffset(-26 * 3600_000);
    expect(Math.abs(now().getTime() - (Date.now() - 26 * 3600_000))).toBeLessThan(50);
  });
});

describe("skewNotice", () => {
  it("says nothing below five minutes", () => {
    expect(skewNotice(4 * 60_000)).toBeNull();
    expect(skewNotice(0)).toBeNull();
  });

  it("names the direction and a readable amount", () => {
    expect(skewNotice(-26 * 3600_000)).toBe(
      "This device's clock is fast by 26 hours; reviews are dated by the correct time."
    );
    expect(skewNotice(10 * 60_000)).toMatch(/slow by 10 minutes/);
    expect(skewNotice(3 * 86400_000)).toMatch(/slow by 3 days/);
  });
});
