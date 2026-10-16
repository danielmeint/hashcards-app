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

/**
 * The SHA git gives a file with this text: SHA-1 over `blob <bytes>\0` and the
 * bytes. What GitHub's tree listing will report for a file the app just
 * committed, so the deck store can record it without fetching it back.
 */
export async function gitBlobSha(text: string): Promise<string> {
  const body = encoder.encode(text);
  const header = encoder.encode(`blob ${body.length}\0`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", concat(header, body)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Identity (PLAN-1.0 §2.7) ------------------------------------------------

/**
 * A card is its text, and only its text: these are what keys are made of.
 *
 * Whitespace is normalised first — every run of it one space, the ends trimmed
 * — so that reflowing a paragraph, re-indenting it or a formatter stripping
 * trailing spaces does not cost a card its history. The parts are joined with
 * NUL, which no card text contains, so where one part ends is never ambiguous.
 *
 * The v1 functions above stay for what still speaks v1: unmigrated
 * collections' logs, and migrating them.
 */
export function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function identity(kind: string, ...parts: string[]): Promise<string> {
  return sha256(encoder.encode([kind, ...parts.map(normaliseWhitespace)].join("\0")).buffer as ArrayBuffer);
}

/** A basic card. Its reverse is the same call with the sides swapped. */
export function basicIdentity(question: string, answer: string): Promise<string> {
  return identity("basic", question, answer);
}

/**
 * One deletion of a cloze block, as the text before it, the text it hides and
 * the text after — all with every bracket removed, so that bracketing another
 * word of the sentence leaves this deletion the card it was.
 */
export function clozeIdentity(before: string, deleted: string, after: string): Promise<string> {
  return identity("cloze", before, deleted, after);
}

/** What the deletions of one cloze block share: its text, brackets removed. */
export function clozeFamilyIdentity(cleanText: string): Promise<string> {
  return identity("cloze", cleanText);
}
