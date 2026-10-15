import { CardStatus, ClozeCard, ParsedCard } from "./types";
import { hashBasicCard, hashClozeCard, hashClozeFamily } from "./hash";
import { formatKey, isValidId } from "./card-key";

type DeckMetadata = {
  name: string | null;
  /** Every card in the file carries these, before any of its own. */
  tags: string[];
};

function extractFrontmatter(
  text: string,
  filePath: string
): {
  metadata: DeckMetadata;
  content: string;
  /** Lines removed from the top, so line numbers can be made absolute again. */
  lineOffset: number;
} {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { metadata: { name: null, tags: [] }, content: text, lineOffset: 0 };
  }

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIdx = i;
      break;
    }
  }

  if (closingIdx === -1) {
    throw new Error("Frontmatter opening '---' found but no closing '---'");
  }

  const frontmatterLines = lines.slice(1, closingIdx);
  let name: string | null = null;
  let tags: string[] = [];
  for (const [i, line] of frontmatterLines.entries()) {
    const match = line.match(/^\s*name\s*=\s*"([^"]*)"\s*$/);
    if (match) {
      name = match[1];
    }
    const tagsMatch = line.match(/^\s*tags\s*=\s*(.*?)\s*$/);
    if (tagsMatch) {
      const parsed = parseStringArray(tagsMatch[1]);
      if (parsed === null) {
        throw new Error(
          `Frontmatter tags must be a TOML array of strings on one line, like tags = ["geo", "europe"]. Found: ${line.trim()}`
        );
      }
      tags = normaliseTags(parsed, `Location: ${filePath}:${i + 2}`);
    }
  }

  const content = lines.slice(closingIdx + 1).join("\n");
  return { metadata: { name, tags }, content, lineOffset: closingIdx + 1 };
}

/**
 * A one-line TOML array of strings — `["geo", 'europe',]` — or null for
 * anything else. Not a TOML parser: the frontmatter has two keys, and a whole
 * TOML dependency for them would be most of the parser's weight. Basic-string
 * escapes are JSON's, which covers every escape a tag could plausibly need.
 */
function parseStringArray(src: string): string[] | null {
  const body = src.match(/^\[(.*)\]$/);
  if (!body) return null;
  const items: string[] = [];
  let rest = body[1].trim();
  while (rest !== "") {
    const item = rest.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
    if (!item) return null;
    if (item[1] !== undefined) {
      try {
        items.push(JSON.parse(`"${item[1]}"`) as string);
      } catch {
        return null;
      }
    } else {
      items.push(item[2]);
    }
    rest = rest.slice(item[0].length).trim();
    if (rest.startsWith(",")) rest = rest.slice(1).trim();
    else if (rest !== "") return null;
  }
  return items;
}

/**
 * What a tag must look like once normalised: lowercase words of letters,
 * digits, `_` and `-`, joined by `/` for hierarchy. Narrow on purpose: tags
 * become filters, URL fragments and CLI arguments, and every character outside
 * this set is one some consumer would have to quote or escape.
 */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

/**
 * A tag as written, in its one canonical spelling — or null for a blank one.
 *
 * Normalised rather than rejected because the same tag arrives spelled many
 * ways (`CKA::Type::Syntax Pattern` from Anki, `cka/type/syntax-pattern` from
 * a person), and two spellings of one tag would split one filter into two.
 * Only what normalising cannot rescue is an error.
 */
export function normaliseTag(raw: string): string | null {
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/::/g, "/")
    .replace(/\s+/g, "-")
    .replace(/^\/+|\/+$/g, "");
  return tag === "" ? null : tag;
}

/** `raw` normalised, blanks dropped, repeats removed; throws on an invalid one. */
function normaliseTags(raw: string[], location: string): string[] {
  const tags: string[] = [];
  for (const written of raw) {
    const tag = normaliseTag(written);
    if (tag === null) continue;
    if (!TAG_PATTERN.test(tag)) {
      throw new Error(
        `Invalid tag '${written.trim()}' (read as '${tag}'): use lowercase letters, digits, '_' and '-', with '/' between levels, like 'cka/type/syntax-pattern'. ${location}`
      );
    }
    tags.push(tag);
  }
  return uniqueTags(tags);
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

/**
 * A metadata line: `ID:`, `Tags:`, `Reverse:` or `Status:`. Only ever looked for
 * at the top of a block, before its `Q:` or `C:` — once a card's text has
 * started, nothing is metadata, so an answer can say "Status: pending" and mean
 * it.
 */
// `\r?` because `.` never matches a carriage return: a CRLF file's lines all
// end in one, and without it no line of such a file would be metadata.
const METADATA_LINE = /^(ID|Tags|Reverse|Status):(.*)\r?$/;

type MetadataKey = "ID" | "Tags" | "Reverse" | "Status";

/**
 * The metadata lines at the top of `text` (a card block as the editor holds
 * it), by key, raw values trimmed. Blank lines before and between them are
 * skipped; the first other line ends the run.
 */
export function topMetadata(text: string): Map<MetadataKey, string> {
  const found = new Map<MetadataKey, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = line.match(METADATA_LINE);
    if (!match) break;
    found.set(match[1] as MetadataKey, match[2].trim());
  }
  return found;
}

/** Everything a block's metadata lines said. Line numbers are content-relative. */
type BlockMeta = {
  /** The block's first metadata line: where the card's range starts. */
  startLine: number;
  id: { value: string; line: number } | null;
  tags: string[];
  /** The `Reverse: yes` line, if there was one. */
  reverse: number | null;
  status: CardStatus;
  seen: Set<MetadataKey>;
};

enum LineType {
  StartQuestion,
  StartAnswer,
  StartCloze,
  StartExtra,
  Separator,
  Metadata,
  Text,
  Eof,
}

type Line =
  | { type: LineType.StartQuestion; text: string }
  | { type: LineType.StartAnswer; text: string }
  | { type: LineType.StartCloze; text: string }
  | { type: LineType.StartExtra; text: string }
  | { type: LineType.Separator }
  | { type: LineType.Metadata; key: MetadataKey; value: string }
  | { type: LineType.Text; text: string }
  | { type: LineType.Eof };

/**
 * `atBlockTop` is whether a metadata line would mean anything here. Inside a
 * card's text it is just text, and classifying it that way up front keeps the
 * reading states from having to know metadata exists.
 */
function readLine(line: string, atBlockTop: boolean): Line {
  if (line.startsWith("Q:")) {
    return { type: LineType.StartQuestion, text: line.slice(2).trim() };
  } else if (line.startsWith("A:")) {
    return { type: LineType.StartAnswer, text: line.slice(2).trim() };
  } else if (line.startsWith("C:")) {
    return { type: LineType.StartCloze, text: line.slice(2).trim() };
  } else if (line.startsWith("Extra:")) {
    return { type: LineType.StartExtra, text: line.slice(6).trim() };
  } else if (line.trim() === "---") {
    return { type: LineType.Separator };
  }
  const meta = atBlockTop ? line.match(METADATA_LINE) : null;
  if (meta) {
    return { type: LineType.Metadata, key: meta[1] as MetadataKey, value: meta[2].trim() };
  }
  return { type: LineType.Text, text: line };
}

/**
 * Where a card begins, carried through the states that read it. `implicit` is
 * a card begun by the tag that ended the one before it, rather than at the top
 * of the file or after a `---`: it has no block top, so nowhere metadata could
 * go. `stampIds` needs to know, since an ID line put there would land in the
 * previous card's answer.
 */
type Opening = { startLine: number; meta: BlockMeta | null; implicit: boolean };

/**
 * A card's `Extra:` section while it is being read: its text so far and the
 * line it started on, for an error to point at. Null until one starts.
 */
type ExtraSection = { text: string; line: number } | null;

type State =
  | { type: "start"; meta: BlockMeta | null }
  | ({ type: "readingQuestion"; question: string } & Opening)
  | ({ type: "readingAnswer"; question: string; answer: string; extra: ExtraSection } & Opening)
  | ({ type: "readingCloze"; text: string; extra: ExtraSection } & Opening)
  | { type: "end" };

/**
 * Line numbers are 0-based and relative to the post-frontmatter content.
 * `startLine` is the top of the block, metadata included: deleting a card in
 * the editor must take its ID with it, or the ID would attach itself to
 * whatever card came next.
 */
export type RawCard = {
  startLine: number;
  endLine: number;
  /** The `Extra:` section, trimmed, or null for a card without one. */
  extra: string | null;
} & Opening &
  (
    | { type: "basic"; question: string; answer: string }
    | { type: "clozeGroup"; text: string }
  );

export type ScannedFile = {
  metadata: DeckMetadata;
  /** The file's lines, frontmatter included; `lineOffset` maps raw lines into it. */
  lines: string[];
  lineOffset: number;
  cards: RawCard[];
};

/**
 * The file read into card blocks, without hashing anything — the synchronous
 * half of `parseFile`, and all `stampIds` needs to find where IDs go.
 */
export function scanFile(text: string, filePath: string): ScannedFile {
  const { metadata, content, lineOffset } = extractFrontmatter(text, filePath);

  const cards: RawCard[] = [];
  const lines = content.split("\n");
  const lastLine = lines.length === 0 ? 0 : lines.length - 1;
  // Absolute and 1-based, like a card's range: what a person opening the file
  // will look for, frontmatter and all.
  const at = (lineNum: number) =>
    `Location: ${filePath}:${lineOffset + lineNum + 1}`;

  let state: State = { type: "start", meta: null };
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = readLine(lines[lineNum], state.type === "start");
    state = parseLine(state, line, lineNum, cards, at);
  }
  parseLine(state, { type: LineType.Eof }, lastLine, cards, at);

  return { metadata, lines: text.split("\n"), lineOffset, cards };
}

export async function parseFile(
  text: string,
  filePath: string,
  defaultDeckName: string
): Promise<ParsedCard[]> {
  const { metadata, lines: fileLines, lineOffset, cards: rawCards } = scanFile(
    text,
    filePath
  );
  const deckName = metadata.name ?? defaultDeckName;
  const lines = fileLines.slice(lineOffset);
  const at = (lineNum: number) =>
    `Location: ${filePath}:${lineOffset + lineNum + 1}`;

  /**
   * Where a card lives in the file it came from: absolute, 1-based, inclusive
   * — the form a `#L12-L18` link wants, and the form a person reading an error
   * message expects.
   */
  function rangeOf(raw: RawCard): [number, number] {
    let end = Math.max(raw.startLine, raw.endLine);
    // The separator that ended the card is not part of it, and neither are the
    // blank lines people leave before one.
    while (end > raw.startLine && lines[end]?.trim() === "") end--;
    return [lineOffset + raw.startLine + 1, lineOffset + end + 1];
  }

  const cards: ParsedCard[] = [];
  const seenHashes = new Set<string>();
  const add = (card: ParsedCard) => {
    if (seenHashes.has(card.hash)) return;
    seenHashes.add(card.hash);
    cards.push(card);
  };

  // Within this file only. Uniqueness across the collection is a question for
  // whatever reads every file at once (`hc lint`), not for a parser handed one.
  const idLines = new Map<string, number>();

  for (const raw of rawCards) {
    const meta = raw.meta;
    const id = meta?.id?.value ?? null;
    if (meta?.id) {
      const first = idLines.get(meta.id.value);
      if (first !== undefined) {
        throw new Error(
          `Duplicate card ID '${meta.id.value}', already used on line ${lineOffset + first + 1}. ${at(meta.id.line)}`
        );
      }
      idLines.set(meta.id.value, meta.id.line);
    }
    const shared = {
      deckName,
      filePath,
      range: rangeOf(raw),
      id,
      tags: uniqueTags([...metadata.tags, ...(meta?.tags ?? [])]),
      status: meta?.status ?? ("active" as const),
    };

    if (raw.type === "basic") {
      const hash = await hashBasicCard(raw.question, raw.answer);
      // Extra stays out of every hash and key: it is a note about the card,
      // not the card, so rewriting it must not cost the card its history.
      const extra = raw.extra === null ? {} : { extra: raw.extra };
      add({
        ...shared,
        content: { type: "basic", question: raw.question, answer: raw.answer, ...extra },
        hash,
        familyHash: null,
        key: id ? formatKey({ kind: "basic", id }) : formatKey({ kind: "hash", hash }),
      });
      if (meta?.reverse != null) {
        // The same two sides the other way round, hashed as if someone had
        // written that card out by hand — which is what it is.
        const reverseHash = await hashBasicCard(raw.answer, raw.question);
        add({
          ...shared,
          content: { type: "basic", question: raw.answer, answer: raw.question, ...extra },
          hash: reverseHash,
          familyHash: null,
          key: id
            ? formatKey({ kind: "reverse", id })
            : formatKey({ kind: "hash", hash: reverseHash }),
        });
      }
    } else {
      const deletions = await parseClozeCards(raw.text, filePath);
      deletions.forEach((deletion, i) => {
        add({
          ...shared,
          ...deletion,
          content:
            raw.extra === null ? deletion.content : { ...deletion.content, extra: raw.extra },
          key: id
            ? formatKey({ kind: "cloze", id, n: i + 1 })
            : formatKey({ kind: "hash", hash: deletion.hash }),
        });
      });
    }
  }

  return cards;
}

/** Fold one metadata line into the block's, refusing anything it cannot mean. */
function readMetadata(
  meta: BlockMeta | null,
  line: { key: MetadataKey; value: string },
  lineNum: number,
  at: (lineNum: number) => string
): BlockMeta {
  const next: BlockMeta = meta ?? {
    startLine: lineNum,
    id: null,
    tags: [],
    reverse: null,
    status: "active",
    seen: new Set(),
  };
  if (next.seen.has(line.key)) {
    throw new Error(`A card can only have one '${line.key}:' line. ${at(lineNum)}`);
  }
  next.seen.add(line.key);

  switch (line.key) {
    case "ID":
      if (!isValidId(line.value)) {
        throw new Error(
          `Invalid card ID '${line.value}': use 2–64 lowercase letters, digits and '-', not starting with '-'. ${at(lineNum)}`
        );
      }
      next.id = { value: line.value, line: lineNum };
      break;
    case "Tags":
      next.tags = normaliseTags(line.value.split(","), at(lineNum));
      break;
    case "Reverse":
      if (line.value !== "yes" && line.value !== "no") {
        throw new Error(`Reverse must be 'yes' or 'no', not '${line.value}'. ${at(lineNum)}`);
      }
      next.reverse = line.value === "yes" ? lineNum : null;
      break;
    case "Status":
      if (line.value !== "draft" && line.value !== "suspended") {
        throw new Error(
          `Status must be 'draft' or 'suspended', not '${line.value}'. ${at(lineNum)}`
        );
      }
      next.status = line.value;
      break;
  }
  return next;
}

/** An `Extra:` line, refused if the card already has its one Extra section. */
function startExtra(
  current: ExtraSection,
  text: string,
  lineNum: number,
  at: (lineNum: number) => string
): ExtraSection {
  if (current) {
    throw new Error(`A card can only have one Extra: section. ${at(lineNum)}`);
  }
  return { text, line: lineNum };
}

/** The finished section's text, refusing an `Extra:` that says nothing. */
function finishExtra(extra: ExtraSection, at: (lineNum: number) => string): string | null {
  if (!extra) return null;
  const text = extra.text.trim();
  if (text === "") throw new Error(`Found Extra: with nothing after it. ${at(extra.line)}`);
  return text;
}

function parseLine(
  state: State,
  line: Line,
  lineNum: number,
  cards: RawCard[],
  at: (lineNum: number) => string
): State {
  // Whatever ends a card is itself the next card's first line — except at end
  // of file, where the card runs to the line we were handed.
  const endLine = line.type === LineType.Eof ? lineNum : lineNum - 1;
  // A card begun by the tag that ended the previous one.
  const implicit: Opening = { startLine: lineNum, meta: null, implicit: true };
  const opening = (s: Opening): Opening => ({
    startLine: s.startLine,
    meta: s.meta,
    implicit: s.implicit,
  });

  switch (state.type) {
    case "start": {
      const fromTop: Opening = {
        startLine: state.meta?.startLine ?? lineNum,
        meta: state.meta,
        implicit: false,
      };
      switch (line.type) {
        case LineType.StartQuestion:
          return { type: "readingQuestion", question: line.text, ...fromTop };
        case LineType.StartAnswer:
          throw new Error(`Found answer tag without a question. ${at(lineNum)}`);
        case LineType.StartExtra:
          throw new Error(`Found Extra: without a card before it. ${at(lineNum)}`);
        case LineType.StartCloze:
          if (state.meta?.reverse != null) {
            throw new Error(
              `Reverse is for Q:/A: cards; a cloze card cannot be reversed. ${at(state.meta.reverse)}`
            );
          }
          return { type: "readingCloze", text: line.text, extra: null, ...fromTop };
        case LineType.Metadata:
          return { type: "start", meta: readMetadata(state.meta, line, lineNum, at) };
        case LineType.Separator:
          if (state.meta) {
            throw new Error(`Found metadata with no card after it. ${at(state.meta.startLine)}`);
          }
          return state;
        case LineType.Text:
          if (state.meta && line.text.trim() !== "") {
            throw new Error(
              `Found text between a card's metadata and its Q: or C: line. ${at(lineNum)}`
            );
          }
          return state;
        case LineType.Eof:
          if (state.meta) {
            throw new Error(`Found metadata with no card after it. ${at(state.meta.startLine)}`);
          }
          return { type: "end" };
      }
      break;
    }

    case "readingQuestion":
      switch (line.type) {
        case LineType.StartQuestion:
          throw new Error(`New question without answer. ${at(lineNum)}`);
        case LineType.StartAnswer:
          return {
            type: "readingAnswer",
            question: state.question,
            answer: line.text,
            extra: null,
            ...opening(state),
          };
        case LineType.StartCloze:
          throw new Error(`Found cloze tag while reading a question. ${at(lineNum)}`);
        case LineType.StartExtra:
          throw new Error(`Found Extra: before the card's A: line. ${at(lineNum)}`);
        case LineType.Separator:
          throw new Error(`Found flashcard separator while reading a question. ${at(lineNum)}`);
        case LineType.Metadata:
          throw new Error("unreachable: metadata is only read at a block's top");
        case LineType.Text:
          return { ...state, question: state.question + "\n" + line.text };
        case LineType.Eof:
          throw new Error(
            `File ended while reading a question without an answer. ${at(lineNum)}`
          );
      }
      break;

    case "readingAnswer": {
      const emit = () =>
        cards.push({
          type: "basic",
          question: state.question.trim(),
          answer: state.answer.trim(),
          extra: finishExtra(state.extra, at),
          ...opening(state),
          endLine,
        });
      switch (line.type) {
        case LineType.StartQuestion:
          emit();
          return { type: "readingQuestion", question: line.text, ...implicit };
        case LineType.StartAnswer:
          throw new Error(`Found answer tag while reading an answer. ${at(lineNum)}`);
        case LineType.StartExtra:
          return { ...state, extra: startExtra(state.extra, line.text, lineNum, at) };
        case LineType.StartCloze:
          emit();
          return { type: "readingCloze", text: line.text, extra: null, ...implicit };
        case LineType.Separator:
          emit();
          return { type: "start", meta: null };
        case LineType.Metadata:
          throw new Error("unreachable: metadata is only read at a block's top");
        case LineType.Text:
          return state.extra
            ? { ...state, extra: { ...state.extra, text: state.extra.text + "\n" + line.text } }
            : { ...state, answer: state.answer + "\n" + line.text };
        case LineType.Eof:
          emit();
          return { type: "end" };
      }
      break;
    }

    case "readingCloze": {
      const emit = () =>
        cards.push({
          type: "clozeGroup",
          text: state.text,
          extra: finishExtra(state.extra, at),
          ...opening(state),
          endLine,
        });
      switch (line.type) {
        case LineType.StartQuestion:
          emit();
          return { type: "readingQuestion", question: line.text, ...implicit };
        case LineType.StartAnswer:
          throw new Error(`Found answer tag while reading a cloze card. ${at(lineNum)}`);
        case LineType.StartExtra:
          return { ...state, extra: startExtra(state.extra, line.text, lineNum, at) };
        case LineType.StartCloze:
          emit();
          return { type: "readingCloze", text: line.text, extra: null, ...implicit };
        case LineType.Separator:
          emit();
          return { type: "start", meta: null };
        case LineType.Metadata:
          throw new Error("unreachable: metadata is only read at a block's top");
        case LineType.Text:
          return state.extra
            ? { ...state, extra: { ...state.extra, text: state.extra.text + "\n" + line.text } }
            : { ...state, text: state.text + "\n" + line.text };
        case LineType.Eof:
          emit();
          return { type: "end" };
      }
      break;
    }

    case "end":
      throw new Error("Parsed a line after the end of the file.");
  }

  return state;
}

type BracketEvent =
  | { type: "open"; cleanIndex: number }
  | { type: "close"; cleanIndex: number }
  | { type: "char"; byte: number };

/**
 * Walk bytes, handling image mode (`![...]`) and escape mode (`\[`, `\]`).
 * Cloze brackets emit open/close events; all other bytes emit char events.
 */
function scanClozeBytes(
  textBytes: Uint8Array,
  onEvent: (event: BracketEvent) => void
): void {
  let imageMode = false;
  let escapeMode = false;
  let cleanIndex = 0;

  for (let i = 0; i < textBytes.length; i++) {
    const c = textBytes[i];
    if (c === 0x5b) {
      // '['
      if (imageMode || escapeMode) {
        escapeMode = false;
        onEvent({ type: "char", byte: c });
        cleanIndex++;
      } else {
        onEvent({ type: "open", cleanIndex });
      }
    } else if (c === 0x5d) {
      // ']'
      if (imageMode) {
        imageMode = false;
        onEvent({ type: "char", byte: c });
        cleanIndex++;
      } else if (escapeMode) {
        escapeMode = false;
        onEvent({ type: "char", byte: c });
        cleanIndex++;
      } else {
        onEvent({ type: "close", cleanIndex });
      }
    } else if (c === 0x21) {
      // '!'
      if (!imageMode && textBytes[i + 1] === 0x5b) {
        imageMode = true;
      }
      onEvent({ type: "char", byte: c });
      cleanIndex++;
    } else if (c === 0x5c) {
      // '\\'
      if (!escapeMode && (textBytes[i + 1] === 0x5b || textBytes[i + 1] === 0x5d)) {
        escapeMode = true;
      } else {
        onEvent({ type: "char", byte: c });
        cleanIndex++;
      }
    } else {
      onEvent({ type: "char", byte: c });
      cleanIndex++;
    }
  }
}

/** One deletion of a cloze block: its content and its v1 identity. */
type ClozeDeletion = {
  content: ClozeCard;
  hash: string;
  familyHash: string;
};

/**
 * Every deletion in one `C:` block is a separate card, and they all share the
 * block's line range — editing any of them means editing the same lines. In
 * order of appearance, which is what numbers them in their keys.
 */
async function parseClozeCards(
  rawText: string,
  filePath: string
): Promise<ClozeDeletion[]> {
  const text = rawText.trim();
  const textBytes = new TextEncoder().encode(text);

  // Build clean text (without cloze brackets)
  const cleanBytes: number[] = [];
  scanClozeBytes(textBytes, (e) => {
    if (e.type === "char") cleanBytes.push(e.byte);
  });
  const cleanText = new TextDecoder().decode(new Uint8Array(cleanBytes));

  // Find cloze deletions
  const deletions: ClozeCard[] = [];
  let start: number | null = null;

  scanClozeBytes(textBytes, (e) => {
    if (e.type === "open") {
      start = e.cleanIndex;
    } else if (e.type === "close" && start !== null) {
      const end = e.cleanIndex;
      deletions.push({ type: "cloze", text: cleanText, start, end: end - 1 });
      start = null;
    }
  });

  if (deletions.length === 0) {
    throw new Error(
      `Cloze card must contain at least one cloze deletion. File: ${filePath}`
    );
  }

  const familyHash = await hashClozeFamily(cleanText);
  return Promise.all(
    deletions.map(async (content) => ({
      content,
      hash: await hashClozeCard(content.text, content.start, content.end),
      familyHash,
    }))
  );
}
