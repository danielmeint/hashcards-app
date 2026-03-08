const encoder = new TextEncoder();

async function sha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concat(...arrays: Uint8Array[]): ArrayBuffer {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result.buffer as ArrayBuffer;
}

function u64LE(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(n), true);
  return new Uint8Array(buf);
}

export async function hashBasicCard(
  question: string,
  answer: string
): Promise<string> {
  const data = concat(
    encoder.encode("Basic"),
    encoder.encode(question),
    encoder.encode(answer)
  );
  return sha256(data);
}

export async function hashClozeCard(
  text: string,
  start: number,
  end: number
): Promise<string> {
  const data = concat(
    encoder.encode("Cloze"),
    encoder.encode(text),
    u64LE(start),
    u64LE(end)
  );
  return sha256(data);
}

export async function hashClozeFamily(text: string): Promise<string> {
  const data = concat(encoder.encode("Cloze"), encoder.encode(text));
  return sha256(data);
}
