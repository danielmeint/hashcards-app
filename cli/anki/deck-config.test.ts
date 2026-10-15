import { describe, expect, it } from "vitest";
import { decodeDeckConfig, decodeDeckKind } from "./deck-config";
import { pb } from "./protobuf-writer";

/** FSRS-6's default parameters, as Anki would store them after optimising. */
const PARAMS_6 = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

/** A deck options blob shaped like Anki's: steps, limits, then FSRS fields. */
function config(...fsrs: number[][]): Uint8Array {
  return pb.blob(
    pb.packedFloats(1, [1, 10]), // learn_steps
    pb.packedFloats(4, [1, 1, 1, 1, 1, 1, 1]), // easy_days_percentages
    pb.uint(9, 50), // new_per_day
    pb.float(11, 2.5), // initial_ease
    ...fsrs,
    pb.bytes(46, [...new TextEncoder().encode("1970-01-01")]) // ignore_revlogs_before_date
  );
}

describe("decoding a deck options preset", () => {
  it("reads FSRS-6 parameters and the desired retention", () => {
    expect(decodeDeckConfig(config(pb.packedFloats(6, PARAMS_6), pb.float(37, 0.9)))).toEqual({
      version: 6,
      params: PARAMS_6,
      desiredRetention: 0.9,
    });
  });

  it("uses the newest version that has parameters, as Anki does", () => {
    const v5 = PARAMS_6.slice(0, 19);
    const v4 = PARAMS_6.slice(0, 17);
    expect(decodeDeckConfig(config(pb.packedFloats(3, v4), pb.packedFloats(5, v5)))).toMatchObject({
      version: 5,
      params: v5,
    });
    expect(decodeDeckConfig(config(pb.packedFloats(3, v4)))).toMatchObject({ version: 4, params: v4 });
  });

  it("says so when the preset was never optimised", () => {
    // What the real collection has: FSRS on, no parameters stored.
    expect(decodeDeckConfig(config(pb.float(37, 0.9), pb.float(40, 0.9)))).toEqual({
      version: null,
      params: [],
      desiredRetention: 0.9,
    });
    expect(decodeDeckConfig(new Uint8Array())).toEqual({ version: null, params: [], desiredRetention: null });
  });
});

describe("decoding a deck's kind", () => {
  it("names a normal deck's preset", () => {
    expect(decodeDeckKind(pb.blob(pb.bytes(1, pb.uint(1, 1))))).toEqual({
      kind: "normal",
      configId: 1,
      desiredRetention: null,
    });
  });

  it("reads a per-deck retention override and a large preset id", () => {
    const normal = [...pb.uint(1, 1787239897638), ...pb.uint(2, 0), ...pb.float(10, 0.85)];
    expect(decodeDeckKind(pb.blob(pb.bytes(1, normal)))).toEqual({
      kind: "normal",
      configId: 1787239897638,
      desiredRetention: 0.85,
    });
  });

  it("recognises a filtered deck", () => {
    expect(decodeDeckKind(pb.blob(pb.bytes(2, pb.uint(1, 1))))).toEqual({ kind: "filtered" });
  });

  it("refuses a kind that is neither", () => {
    expect(() => decodeDeckKind(new Uint8Array())).toThrow(/neither normal nor filtered/);
  });
});
