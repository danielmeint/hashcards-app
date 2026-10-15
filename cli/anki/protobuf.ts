/**
 * Just enough of the protobuf wire format to read Anki's config blobs.
 *
 * Anki stores deck options (`deck_config.config`) and deck kinds
 * (`decks.kind`) as protobuf messages. A protobuf library plus Anki's .proto
 * files would be a dependency and a code generator for a handful of fields
 * read once per import; the wire format itself is small and stable, so it is
 * read by hand. Field numbers live with their callers (`deck-config.ts`).
 *
 * Unknown fields are kept rather than rejected: Anki adds options every
 * release, and a reader that choked on them would break on the next one.
 */

/**
 * Protobuf wire types. Groups (3, 4) are long deprecated and Anki has none.
 * An object rather than an enum: Node runs these files by stripping types,
 * and an enum is code, not a type.
 */
export const Wire = { Varint: 0, Fixed64: 1, Len: 2, Fixed32: 5 } as const;

export type Field =
  | { num: number; wire: typeof Wire.Varint; value: number }
  | {
      num: number;
      wire: typeof Wire.Fixed64 | typeof Wire.Fixed32 | typeof Wire.Len;
      value: Uint8Array;
    };

/**
 * A varint at `pos`, and where the next field starts.
 *
 * Accumulated as a double rather than with bitwise ops, which are 32-bit in
 * JavaScript: deck IDs are millisecond timestamps and do not fit. Exact up to
 * 2^53, which every ID Anki makes is far below. Negative int64s (ten bytes,
 * two's complement) come out as large positive numbers; nothing read here is
 * ever negative.
 */
function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new Error("protobuf: varint runs past the end");
    const byte = bytes[pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, pos];
    scale *= 128;
  }
  throw new Error("protobuf: varint longer than ten bytes");
}

function take(bytes: Uint8Array, pos: number, length: number): Uint8Array {
  if (pos + length > bytes.length) throw new Error("protobuf: field runs past the end");
  return bytes.subarray(pos, pos + length);
}

/** Every field of one message, in wire order, repeats included. */
export function readFields(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    switch (wire) {
      case Wire.Varint: {
        const [value, next] = readVarint(bytes, pos);
        fields.push({ num, wire, value });
        pos = next;
        break;
      }
      case Wire.Fixed64:
        fields.push({ num, wire, value: take(bytes, pos, 8) });
        pos += 8;
        break;
      case Wire.Fixed32:
        fields.push({ num, wire, value: take(bytes, pos, 4) });
        pos += 4;
        break;
      case Wire.Len: {
        const [length, next] = readVarint(bytes, pos);
        fields.push({ num, wire, value: take(bytes, next, length) });
        pos = next + length;
        break;
      }
      default:
        throw new Error(`protobuf: unsupported wire type ${wire} for field ${num}`);
    }
  }
  return fields;
}

function float32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
}

/**
 * A `repeated float` field. proto3 packs them (one length-delimited run of
 * little-endian float32s), but a parser must also accept them unpacked, one
 * fixed32 per element, and concatenate both forms in order.
 */
export function floats(fields: Field[], num: number): number[] {
  const out: number[] = [];
  for (const f of fields) {
    if (f.num !== num) continue;
    if (f.wire === Wire.Fixed32) out.push(float32(f.value, 0));
    else if (f.wire === Wire.Len) {
      if (f.value.length % 4 !== 0) throw new Error(`protobuf: packed floats in field ${num} are not whole`);
      for (let i = 0; i < f.value.length; i += 4) out.push(float32(f.value, i));
    }
  }
  return out;
}

/** A singular `float` field, or null when absent (proto3: absent means 0 or unset). */
export function float(fields: Field[], num: number): number | null {
  // Last one wins, as protobuf merges singular fields.
  const last = fields.findLast((f) => f.num === num && f.wire === Wire.Fixed32);
  return last ? float32(last.value as Uint8Array, 0) : null;
}

/** A singular varint field (int32, int64, uint32, bool, enum), or null. */
export function varint(fields: Field[], num: number): number | null {
  const last = fields.findLast((f) => f.num === num && f.wire === Wire.Varint);
  return last ? (last.value as number) : null;
}

/** A singular embedded message, as its fields, or null. */
export function message(fields: Field[], num: number): Field[] | null {
  const last = fields.findLast((f) => f.num === num && f.wire === Wire.Len);
  return last ? readFields(last.value as Uint8Array) : null;
}

/**
 * The shortest decimal that is the same float32. Anki stores options as
 * float32, so a desired retention of 0.9 reads back as 0.8999999761581421;
 * written out like that it would look like a different setting.
 */
export function shortestFloat32(value: number): number {
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === Math.fround(value)) return candidate;
  }
  return value;
}
