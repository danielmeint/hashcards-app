import { describe, expect, it } from "vitest";
import {
  BaselineEvent,
  LinkEvent,
  ReviewEvent,
  fallbackTz,
  parseFile,
  parseLine,
  serializeEvent,
  serializeFile,
} from "./events";

const HASH = "c8bf1a4d115ed569d7f5d02b8d81f26f0b938d7f848312c88359e6c08797fd2e";

function ok(line: string) {
  const result = parseLine(line);
  if (!result.ok) throw new Error(`expected ${line} to parse: ${result.error}`);
  return result.event;
}

function error(line: string): string {
  const result = parseLine(line);
  if (result.ok) throw new Error(`expected ${line} not to parse`);
  return result.error;
}

describe("v2 lines", () => {
  // The three examples in PLAN-1.0.md §2.4, verbatim.
  const review = `{"v":2,"card":"est-capital","at":"2026-10-15T07:12:03.120Z","tz":120,"grade":3,"ms":4200}`;
  const baseline = `{"v":2,"kind":"baseline","card":"k3n9wq2p:1","at":"2026-10-13T19:14:37.619Z","s":8.2956,"d":1,"reps":1}`;
  const anki = `{"v":2,"card":"cka-wl-set-image","at":"2026-09-02T18:01:44.000Z","tz":120,"grade":1,"ms":9100,"src":"anki"}`;

  it("reads a review, with kind defaulting to review", () => {
    expect(ok(review)).toEqual<ReviewEvent>({
      v: 2,
      kind: "review",
      card: "est-capital",
      at: "2026-10-15T07:12:03.120Z",
      tz: 120,
      grade: 3,
      ms: 4200,
    });
    expect(ok(anki)).toMatchObject({ src: "anki", grade: 1 });
  });

  it("reads a baseline", () => {
    expect(ok(baseline)).toEqual<BaselineEvent>({
      v: 2,
      kind: "baseline",
      card: "k3n9wq2p:1",
      at: "2026-10-13T19:14:37.619Z",
      s: 8.2956,
      d: 1,
      reps: 1,
    });
  });

  it("writes exactly the line it read", () => {
    for (const line of [review, baseline, anki]) expect(serializeEvent(ok(line))).toBe(line);
  });

  it("round-trips every optional field", () => {
    const full: BaselineEvent = {
      v: 2,
      kind: "baseline",
      card: "owner/repo/k3n9wq2p:r",
      at: "2026-10-13T19:14:37+02:00",
      tz: -300,
      s: 0.2,
      d: 9.5,
      reps: 0,
      grade: 1,
      src: "v1",
    };
    expect(ok(serializeEvent(full))).toEqual(full);
    const minimal: ReviewEvent = {
      v: 2,
      kind: "review",
      card: "x",
      at: "2026-10-13T19:14Z",
      tz: 0,
      grade: 4,
    };
    expect(serializeEvent(minimal)).not.toContain("ms");
    expect(ok(serializeEvent(minimal))).toEqual(minimal);
  });

  it("accepts an explicit kind of review", () => {
    expect(ok(`{"v":2,"kind":"review","card":"a","at":"2026-10-15T07:12:03Z","tz":0,"grade":2}`).kind).toBe(
      "review"
    );
  });

  it("ignores keys it does not know, for files from a newer version", () => {
    expect(ok(`{"v":2,"card":"a","at":"2026-10-15T07:12:03Z","tz":0,"grade":2,"device":"3e2b"}`)).not.toHaveProperty(
      "device"
    );
  });
});

describe("link lines", () => {
  const link = `{"v":2,"kind":"link","card":"h:520e371e59f5a9c3","from":"h:0adbdf261f9947fc","at":"2026-10-16T09:12:03.120Z","tz":120,"src":"edit"}`;

  it("reads a link and writes exactly the line it read", () => {
    expect(ok(link)).toEqual<LinkEvent>({
      v: 2,
      kind: "link",
      card: "h:520e371e59f5a9c3",
      from: "h:0adbdf261f9947fc",
      at: "2026-10-16T09:12:03.120Z",
      tz: 120,
      src: "edit",
    });
    expect(serializeEvent(ok(link))).toBe(link);
  });

  it("refuses a link without both cards, or from a card to itself", () => {
    expect(error(`{"v":2,"kind":"link","card":"a","at":"2026-10-16T09:12:03Z"}`)).toMatch(/"from"/);
    expect(error(`{"v":2,"kind":"link","card":"a","from":"a","at":"2026-10-16T09:12:03Z"}`)).toMatch(/two different/);
  });
});

describe("v1 lines", () => {
  it("read as reviews from v1, keyed by the hash", () => {
    const line = `{"card":"${HASH}","at":"2026-10-13T19:14:32.827Z","grade":4,"s":8.2956,"d":1,"ms":7356}`;
    expect(ok(line)).toEqual<ReviewEvent>({
      v: 2,
      kind: "review",
      card: HASH,
      at: "2026-10-13T19:14:32.827Z",
      tz: 120,
      grade: 4,
      ms: 7356,
      src: "v1",
    });
  });

  it("take the fallback zone: summer time in October, standard time in December", () => {
    const at = (iso: string) => ok(`{"card":"${HASH}","at":"${iso}","grade":3,"s":2,"d":5}`);
    expect(at("2026-10-13T19:14:32.827Z")).toMatchObject({ tz: 120 });
    expect(at("2026-12-01T09:00:00Z")).toMatchObject({ tz: 60 });
  });

  it("take whatever zone the caller says instead", () => {
    const result = parseLine(`{"card":"${HASH}","at":"2026-10-13T19:14:32Z","grade":3,"s":2,"d":5}`, {
      v1Tz: () => -300,
    });
    expect(result.ok && result.event.kind === "review" && result.event.tz).toBe(-300);
  });

  it("serialise as v2, with the assumed zone made explicit", () => {
    const event = ok(`{"card":"${HASH}","at":"2026-10-13T19:14:32Z","grade":3,"s":2,"d":5}`);
    expect(JSON.parse(serializeEvent(event))).toEqual({
      v: 2,
      card: HASH,
      at: "2026-10-13T19:14:32Z",
      tz: 120,
      grade: 3,
      src: "v1",
    });
  });

  it("reject a card that is not a v1 hash", () => {
    expect(error(`{"card":"est-capital","at":"2026-10-13T19:14:32Z","grade":3,"s":2,"d":5}`)).toMatch(/hex hash/);
  });
});

describe("malformed lines", () => {
  const review = { v: 2, card: "a", at: "2026-10-15T07:12:03Z", tz: 120, grade: 3 };
  const with_ = (patch: Record<string, unknown>) => JSON.stringify({ ...review, ...patch });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["an array", "[1,2]", /not a JSON object/],
    ["null", "null", /not a JSON object/],
    ["a later version", with_({ v: 3 }), /unsupported version/],
    ["v as a string", with_({ v: "2" }), /unsupported version/],
    ["an unknown kind", with_({ kind: "undo" }), /unknown "kind"/],
    ["no card", with_({ card: undefined }), /"card"/],
    ["an empty card", with_({ card: "" }), /"card"/],
    ["no at", with_({ at: undefined }), /"at"/],
    ["a date with no time", with_({ at: "2026-10-15" }), /"at"/],
    ["a time with no zone", with_({ at: "2026-10-15T07:12:03" }), /"at"/],
    ["an impossible date", with_({ at: "2026-13-45T07:12:03Z" }), /"at"/],
    ["no tz on a review", with_({ tz: undefined }), /"tz"/],
    ["tz as a string", with_({ tz: "+02:00" }), /"tz"/],
    ["tz out of range", with_({ tz: 900 }), /"tz"/],
    ["a fractional tz", with_({ tz: 120.5 }), /"tz"/],
    ["grade 0", with_({ grade: 0 }), /"grade"/],
    ["grade 5", with_({ grade: 5 }), /"grade"/],
    ["grade as a string", with_({ grade: "3" }), /"grade"/],
    ["negative ms", with_({ ms: -1 }), /"ms"/],
    ["an empty src", with_({ src: "" }), /"src"/],
  ])("rejects %s, saying why", (_, line, why) => {
    expect(error(line)).toMatch(why);
  });

  const baseline = { v: 2, kind: "baseline", card: "a", at: "2026-10-15T07:12:03Z", s: 3, d: 5, reps: 2 };
  it.each([
    ["no stability", { s: undefined }, /"s"/],
    ["zero stability", { s: 0 }, /"s"/],
    ["infinite stability", { s: "Infinity" }, /"s"/],
    ["difficulty below 1", { d: 0.5 }, /"d"/],
    ["difficulty above 10", { d: 11 }, /"d"/],
    ["no reps", { reps: undefined }, /"reps"/],
    ["fractional reps", { reps: 1.5 }, /"reps"/],
    ["grade 7", { grade: 7 }, /"grade"/],
  ])("rejects a baseline with %s", (_, patch, why) => {
    expect(error(JSON.stringify({ ...baseline, ...patch }))).toMatch(why);
  });
});

describe("parseFile", () => {
  const good = `{"v":2,"card":"a","at":"2026-10-15T07:12:03Z","tz":120,"grade":3}`;
  const v1 = `{"card":"${HASH}","at":"2026-10-13T19:14:32Z","grade":3,"s":2,"d":5}`;

  it("keeps every good line, reports every bad one, and skips blank ones", () => {
    const { events, errors } = parseFile([good, "", "{oops", v1, `{"v":2,"card":"a"}`, ""].join("\n"));
    expect(events.map((e) => e.src ?? "v2")).toEqual(["v2", "v1"]);
    expect(errors).toEqual([
      { line: 3, text: "{oops", error: "not valid JSON" },
      { line: 5, text: `{"v":2,"card":"a"}`, error: expect.stringMatching(/"at"/) },
    ]);
  });

  it("takes an array of lines, and Windows line endings", () => {
    expect(parseFile([good, v1]).events).toHaveLength(2);
    expect(parseFile(`${good}\r\n${v1}\r\n`).errors).toEqual([]);
  });

  it("is the inverse of serializeFile", () => {
    const { events } = parseFile([good, v1]);
    const text = serializeFile(events);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseFile(text).events).toEqual(events);
  });
});

describe("fallbackTz", () => {
  it("agrees with the time zone database for Berlin, hour by hour across two years", () => {
    const berlin = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      timeZoneName: "longOffset",
    });
    const offsetOf = (ms: number) => {
      const name = berlin.formatToParts(ms).find((p) => p.type === "timeZoneName")!.value;
      const [, sign, h, m] = /GMT([+-])(\d{2}):(\d{2})/.exec(name)!;
      return (sign === "-" ? -1 : 1) * (Number(h) * 60 + Number(m));
    };
    const start = Date.parse("2025-01-01T00:00:00Z");
    for (let ms = start; ms < start + 2 * 366 * 86_400_000; ms += 3_600_000) {
      const at = new Date(ms).toISOString();
      expect(fallbackTz(at), at).toBe(offsetOf(ms));
    }
  });

  it("switches at 01:00 UTC on the last Sunday of March and October", () => {
    expect(fallbackTz("2026-03-29T00:59:59Z")).toBe(60);
    expect(fallbackTz("2026-03-29T01:00:00Z")).toBe(120);
    expect(fallbackTz("2026-10-25T00:59:59Z")).toBe(120);
    expect(fallbackTz("2026-10-25T01:00:00Z")).toBe(60);
  });
});
