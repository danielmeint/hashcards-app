/**
 * Anki's FSRS settings, out of its protobuf blobs.
 *
 * FSRS parameters are per deck options preset (`deck_config`), and each deck
 * names its preset in `decks.kind`. The parity check (M6) needs both: a card
 * is scheduled with the parameters of its deck's preset, and replaying it
 * with any others would not reproduce Anki's due dates.
 *
 * Field numbers are from Anki's own descriptors (`anki/deck_config.proto`,
 * `anki/decks.proto`, read out of the Anki 25.x app bundle):
 *
 *   DeckConfig.Config  3 fsrs_params_4   repeated float
 *                      5 fsrs_params_5   repeated float
 *                      6 fsrs_params_6   repeated float
 *                     37 desired_retention float
 *   Deck.KindContainer 1 normal (Deck.Normal), 2 filtered
 *   Deck.Normal        1 config_id int64
 *                     10 desired_retention float (a per-deck override)
 */

import { type Field, floats, float, message, readFields, shortestFloat32, varint } from "./protobuf.ts";

const CONFIG = { fsrsParams4: 3, fsrsParams5: 5, fsrsParams6: 6, desiredRetention: 37 } as const;
const KIND = { normal: 1, filtered: 2 } as const;
const NORMAL = { configId: 1, desiredRetention: 10 } as const;

export type FsrsSettings = {
  /**
   * Which FSRS the parameters are for: 6, 5 or 4. Null when the preset has
   * never been optimised: Anki then schedules with the built-in defaults of
   * whatever FSRS version the app runs, which the collection does not record.
   */
  version: 4 | 5 | 6 | null;
  params: number[];
  desiredRetention: number | null;
};

/**
 * The FSRS settings of one preset. Anki keeps a list per FSRS version and
 * uses the newest non-empty one, falling back to older ones after an upgrade
 * until the user re-optimises; this reports the one it would use.
 */
export function decodeDeckConfig(blob: Uint8Array): FsrsSettings {
  const fields = readFields(blob);
  const candidates: [6 | 5 | 4, number][] = [
    [6, CONFIG.fsrsParams6],
    [5, CONFIG.fsrsParams5],
    [4, CONFIG.fsrsParams4],
  ];
  let version: FsrsSettings["version"] = null;
  let params: number[] = [];
  for (const [v, num] of candidates) {
    const found = floats(fields, num);
    if (found.length) {
      version = v;
      params = found.map(shortestFloat32);
      break;
    }
  }
  const retention = float(fields, CONFIG.desiredRetention);
  return { version, params, desiredRetention: retention === null ? null : shortestFloat32(retention) };
}

export type DeckKind =
  | { kind: "normal"; configId: number; desiredRetention: number | null }
  | { kind: "filtered" };

/**
 * What a deck's `kind` blob says. A filtered deck has no preset of its own;
 * its cards keep scheduling by their home deck's (`odid`).
 */
export function decodeDeckKind(blob: Uint8Array): DeckKind {
  const fields = readFields(blob);
  const normal: Field[] | null = message(fields, KIND.normal);
  if (!normal) {
    if (message(fields, KIND.filtered)) return { kind: "filtered" };
    throw new Error("deck kind is neither normal nor filtered");
  }
  const retention = float(normal, NORMAL.desiredRetention);
  return {
    kind: "normal",
    // proto3 omits a zero; Anki's default preset is id 1, never 0.
    configId: varint(normal, NORMAL.configId) ?? 0,
    desiredRetention: retention === null ? null : shortestFloat32(retention),
  };
}
