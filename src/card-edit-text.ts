import { topMetadata } from "./parser";

/**
 * The text half of editing a card: which lines are the card, and how a
 * rewrite goes back into the file. Pure, and kept apart from `card-edit.ts`
 * so that what the Inbox does to a file (`draft-edits.ts`) can share it
 * without importing the sync machinery that commits it.
 */

/** The lines `range` covers: absolute, 1-based, inclusive, as `Card` means it. */
export function sliceLines(file: string, [start, end]: [number, number]): string {
  return file.split("\n").slice(start - 1, end).join("\n");
}

/**
 * Put `replacement` where `range` used to be. An empty replacement removes
 * those lines outright — clearing the box is how a card gets deleted, which
 * needs no separate button and no confirmation dialog to explain itself.
 */
export function spliceLines(
  file: string,
  [start, end]: [number, number],
  replacement: string
): string {
  const lines = file.split("\n");
  const inserted =
    replacement.trim() === "" ? [] : replacement.replace(/\n+$/, "").split("\n");
  lines.splice(start - 1, end - start + 1, ...inserted);
  return lines.join("\n");
}

/**
 * `replacement`, with the edited card's `ID:` line put back if the edit lost it.
 *
 * A card's range covers its metadata lines, so the editor shows them and they
 * can be changed like any other line — tags added, a draft accepted. The ID is
 * the exception: it is what the card's history hangs on, and a box where it is
 * one easy line to select away with the rest should not be able to strand that
 * history. Clearing the box still takes the ID with it, as deleting the card
 * should; and an ID the edit changed is a deliberate change, so it stands.
 */
export function keepId(original: string, replacement: string): string {
  if (replacement.trim() === "") return replacement;
  const id = topMetadata(original).get("ID");
  if (id === undefined || topMetadata(replacement).has("ID")) return replacement;
  return `ID: ${id}\n${replacement}`;
}
