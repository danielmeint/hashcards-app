import { describe, expect, it } from "vitest";
import { Wire, float, floats, message, readFields, shortestFloat32, varint } from "./protobuf.ts";
import { pb } from "./protobuf-writer.ts";

describe("the protobuf reader", () => {
  it("reads varints past 32 bits, as deck IDs need", () => {
    const fields = readFields(pb.blob(pb.uint(1, 1787239897638), pb.uint(2, 0), pb.uint(3, 300)));
    expect(varint(fields, 1)).toBe(1787239897638);
    expect(varint(fields, 2)).toBe(0);
    expect(varint(fields, 3)).toBe(300);
    expect(varint(fields, 4)).toBeNull();
  });

  it("reads repeated floats packed, unpacked, and both at once", () => {
    const fields = readFields(
      pb.blob(pb.packedFloats(6, [0.5, 1.25]), pb.float(6, 2), pb.packedFloats(6, [-3]))
    );
    expect(floats(fields, 6)).toEqual([0.5, 1.25, 2, -3]);
    expect(floats(fields, 5)).toEqual([]);
  });

  it("reads a singular float, the last one winning", () => {
    const fields = readFields(pb.blob(pb.float(37, 0.5), pb.float(37, 0.9)));
    expect(float(fields, 37)).toBe(Math.fround(0.9));
    expect(float(fields, 1)).toBeNull();
  });

  it("reads embedded messages", () => {
    const fields = readFields(pb.blob(pb.bytes(1, [...pb.uint(1, 7), ...pb.float(10, 0.85)])));
    const inner = message(fields, 1)!;
    expect(varint(inner, 1)).toBe(7);
    expect(float(inner, 10)).toBe(Math.fround(0.85));
    expect(message(fields, 2)).toBeNull();
  });

  it("steps over fields it was not asked about, of every wire type", () => {
    const fixed64 = [...pb.tag(9, Wire.Fixed64), 1, 2, 3, 4, 5, 6, 7, 8];
    const fields = readFields(
      pb.blob(pb.bytes(255, [1, 2, 3]), fixed64, pb.uint(46, 1), pb.float(37, 0.75))
    );
    expect(fields.map((f) => [f.num, f.wire])).toEqual([[255, 2], [9, 1], [46, 0], [37, 5]]);
    expect(float(fields, 37)).toBe(0.75);
  });

  it("reads an empty message as no fields", () => {
    expect(readFields(new Uint8Array())).toEqual([]);
  });

  it.each([
    ["a truncated varint", [0x08, 0x80]],
    ["a length past the end", [0x0a, 0x05, 1, 2]],
    ["a truncated float", [0x2d, 0, 0]],
    ["a group", [0x0b]],
  ])("refuses %s", (_, bytes) => {
    expect(() => readFields(new Uint8Array(bytes))).toThrow(/protobuf/);
  });

  it("refuses packed floats that are not whole", () => {
    expect(() => floats(readFields(pb.blob(pb.bytes(6, [1, 2, 3]))), 6)).toThrow(/not whole/);
  });

  it("writes float32s as the shortest decimal that is the same float", () => {
    expect(shortestFloat32(Math.fround(0.9))).toBe(0.9);
    expect(shortestFloat32(Math.fround(0.212))).toBe(0.212);
    expect(shortestFloat32(Math.fround(1.2931))).toBe(1.2931);
    expect(shortestFloat32(2)).toBe(2);
  });
});
