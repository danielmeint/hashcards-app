import { Card } from "./types";
import { hashBasicCard, hashClozeCard, hashClozeFamily } from "./hash";

type DeckMetadata = {
  name: string | null;
};

function extractFrontmatter(text: string): { metadata: DeckMetadata; content: string } {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { metadata: { name: null }, content: text };
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
  for (const line of frontmatterLines) {
    const match = line.match(/^\s*name\s*=\s*"([^"]*)"\s*$/);
    if (match) {
      name = match[1];
    }
  }

  const content = lines.slice(closingIdx + 1).join("\n");
  return { metadata: { name }, content };
}

enum LineType {
  StartQuestion,
  StartAnswer,
  StartCloze,
  Separator,
  Text,
  Eof,
}

type Line =
  | { type: LineType.StartQuestion; text: string }
  | { type: LineType.StartAnswer; text: string }
  | { type: LineType.StartCloze; text: string }
  | { type: LineType.Separator }
  | { type: LineType.Text; text: string }
  | { type: LineType.Eof };

function readLine(line: string): Line {
  if (line.startsWith("Q:")) {
    return { type: LineType.StartQuestion, text: line.slice(2).trim() };
  } else if (line.startsWith("A:")) {
    return { type: LineType.StartAnswer, text: line.slice(2).trim() };
  } else if (line.startsWith("C:")) {
    return { type: LineType.StartCloze, text: line.slice(2).trim() };
  } else if (line.trim() === "---") {
    return { type: LineType.Separator };
  } else {
    return { type: LineType.Text, text: line };
  }
}

type State =
  | { type: "start" }
  | { type: "readingQuestion"; question: string; startLine: number }
  | {
      type: "readingAnswer";
      question: string;
      answer: string;
      startLine: number;
    }
  | { type: "readingCloze"; text: string; startLine: number }
  | { type: "end" };

type RawCard =
  | { type: "basic"; question: string; answer: string }
  | { type: "clozeGroup"; text: string };

export async function parseFile(
  text: string,
  filePath: string,
  defaultDeckName: string
): Promise<Card[]> {
  const { metadata, content } = extractFrontmatter(text);
  const deckName = metadata.name ?? defaultDeckName;

  const rawCards: RawCard[] = [];
  let state: State = { type: "start" };
  const lines = content.split("\n");
  const lastLine = lines.length === 0 ? 0 : lines.length - 1;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = readLine(lines[lineNum]);
    state = parseLine(state, line, lineNum, rawCards, filePath);
  }
  parseLine(state, { type: LineType.Eof }, lastLine, rawCards, filePath);

  const cards: Card[] = [];
  const seenHashes = new Set<string>();

  for (const raw of rawCards) {
    if (raw.type === "basic") {
      const hash = await hashBasicCard(raw.question, raw.answer);
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        cards.push({
          deckName,
          filePath,
          range: [0, 0],
          content: { type: "basic", question: raw.question, answer: raw.answer },
          hash,
          familyHash: null,
        });
      }
    } else {
      const clozeCards = await parseClozeCards(raw.text, deckName, filePath);
      for (const card of clozeCards) {
        if (!seenHashes.has(card.hash)) {
          seenHashes.add(card.hash);
          cards.push(card);
        }
      }
    }
  }

  return cards;
}

function parseLine(
  state: State,
  line: Line,
  lineNum: number,
  cards: RawCard[],
  filePath: string
): State {
  switch (state.type) {
    case "start":
      switch (line.type) {
        case LineType.StartQuestion:
          return { type: "readingQuestion", question: line.text, startLine: lineNum };
        case LineType.StartAnswer:
          throw new Error(
            `Found answer tag without a question. Location: ${filePath}:${lineNum + 1}`
          );
        case LineType.StartCloze:
          return { type: "readingCloze", text: line.text, startLine: lineNum };
        case LineType.Separator:
        case LineType.Text:
          return { type: "start" };
        case LineType.Eof:
          return { type: "end" };
      }
      break;

    case "readingQuestion":
      switch (line.type) {
        case LineType.StartQuestion:
          throw new Error(
            `New question without answer. Location: ${filePath}:${lineNum + 1}`
          );
        case LineType.StartAnswer:
          return {
            type: "readingAnswer",
            question: state.question,
            answer: line.text,
            startLine: state.startLine,
          };
        case LineType.StartCloze:
          throw new Error(
            `Found cloze tag while reading a question. Location: ${filePath}:${lineNum + 1}`
          );
        case LineType.Separator:
          throw new Error(
            `Found flashcard separator while reading a question. Location: ${filePath}:${lineNum + 1}`
          );
        case LineType.Text:
          return {
            type: "readingQuestion",
            question: state.question + "\n" + line.text,
            startLine: state.startLine,
          };
        case LineType.Eof:
          throw new Error(
            `File ended while reading a question without an answer. Location: ${filePath}:${lineNum + 1}`
          );
      }
      break;

    case "readingAnswer":
      switch (line.type) {
        case LineType.StartQuestion: {
          const q = state.question.trim();
          const a = state.answer.trim();
          cards.push({ type: "basic", question: q, answer: a });
          return { type: "readingQuestion", question: line.text, startLine: lineNum };
        }
        case LineType.StartAnswer:
          throw new Error(
            `Found answer tag while reading an answer. Location: ${filePath}:${lineNum + 1}`
          );
        case LineType.StartCloze: {
          const q = state.question.trim();
          const a = state.answer.trim();
          cards.push({ type: "basic", question: q, answer: a });
          return { type: "readingCloze", text: line.text, startLine: lineNum };
        }
        case LineType.Separator: {
          const q = state.question.trim();
          const a = state.answer.trim();
          cards.push({ type: "basic", question: q, answer: a });
          return { type: "start" };
        }
        case LineType.Text:
          return {
            type: "readingAnswer",
            question: state.question,
            answer: state.answer + "\n" + line.text,
            startLine: state.startLine,
          };
        case LineType.Eof: {
          const q = state.question.trim();
          const a = state.answer.trim();
          cards.push({ type: "basic", question: q, answer: a });
          return { type: "end" };
        }
      }
      break;

    case "readingCloze":
      switch (line.type) {
        case LineType.StartQuestion:
          cards.push({ type: "clozeGroup", text: state.text });
          return { type: "readingQuestion", question: line.text, startLine: lineNum };
        case LineType.StartAnswer:
          throw new Error(
            `Found answer tag while reading a cloze card. Location: ${filePath}:${lineNum + 1}`
          );
        case LineType.StartCloze:
          cards.push({ type: "clozeGroup", text: state.text });
          return { type: "readingCloze", text: line.text, startLine: lineNum };
        case LineType.Separator:
          cards.push({ type: "clozeGroup", text: state.text });
          return { type: "start" };
        case LineType.Text:
          return {
            type: "readingCloze",
            text: state.text + "\n" + line.text,
            startLine: state.startLine,
          };
        case LineType.Eof:
          cards.push({ type: "clozeGroup", text: state.text });
          return { type: "end" };
      }
      break;

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

async function parseClozeCards(
  rawText: string,
  deckName: string,
  filePath: string
): Promise<Card[]> {
  const text = rawText.trim();
  const textBytes = new TextEncoder().encode(text);

  // Build clean text (without cloze brackets)
  const cleanBytes: number[] = [];
  scanClozeBytes(textBytes, (e) => {
    if (e.type === "char") cleanBytes.push(e.byte);
  });
  const cleanText = new TextDecoder().decode(new Uint8Array(cleanBytes));

  // Find cloze deletions
  const cards: Card[] = [];
  let start: number | null = null;

  scanClozeBytes(textBytes, (e) => {
    if (e.type === "open") {
      start = e.cleanIndex;
    } else if (e.type === "close" && start !== null) {
      const end = e.cleanIndex;
      // Card creation is synchronous here; we'll hash after
      cards.push({
        deckName,
        filePath,
        range: [0, 0],
        content: { type: "cloze", text: cleanText, start, end: end - 1 },
        hash: "", // filled below
        familyHash: null, // filled below
      });
      start = null;
    }
  });

  // Fill in hashes (async)
  const familyHash = cards.length > 0 ? await hashClozeFamily(cleanText) : null;
  for (const card of cards) {
    const c = card.content as { type: "cloze"; text: string; start: number; end: number };
    card.hash = await hashClozeCard(c.text, c.start, c.end);
    card.familyHash = familyHash;
  }

  if (cards.length === 0) {
    throw new Error(
      `Cloze card must contain at least one cloze deletion. File: ${filePath}`
    );
  }

  return cards;
}
