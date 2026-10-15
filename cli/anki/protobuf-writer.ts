/**
 * A minimal protobuf writer, for tests to build blobs the reader has never
 * seen. Test-only: the importer never writes protobuf. Written independently
 * of the reader so the two cannot share a mistake.
 */
export const pb = {
  varint(n: number): number[] {
    const out: number[] = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return out;
  },
  tag(num: number, wire: number): number[] {
    return pb.varint(num * 8 + wire);
  },
  uint(num: number, n: number): number[] {
    return [...pb.tag(num, 0), ...pb.varint(n)];
  },
  f32(n: number): number[] {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    return [...b];
  },
  float(num: number, n: number): number[] {
    return [...pb.tag(num, 5), ...pb.f32(n)];
  },
  bytes(num: number, body: number[]): number[] {
    return [...pb.tag(num, 2), ...pb.varint(body.length), ...body];
  },
  packedFloats(num: number, ns: number[]): number[] {
    return pb.bytes(num, ns.flatMap(pb.f32));
  },
  blob(...parts: number[][]): Uint8Array {
    return new Uint8Array(parts.flat());
  },
};
