import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile, scanFile } from "../src/parser";
import type { ParsedCard } from "../src/types";
import { matchesAny } from "./glob";
import { readConfig } from "./config";
import type { Config, ConfigResult } from "./config";

/**
 * A card repo read from disk: which files are decks, their cards, and what is
 * wrong with them. Every command starts here.
 *
 * Files come from the working tree, not from a commit: `hc add` followed by
 * `hc lint` must see the card just added.
 */

/**
 * Documentation, not decks, when `hashcards.toml` has no `[decks]`: the usual
 * repo files by name, and any all-caps name with a `_` or `-` in it
 * (`CARD_GUIDE.md`, `CODE_OF_CONDUCT.md`). A deck can still be called
 * `CKA.md`; one called `CKA_NOTES.md` needs a `[decks]` table to be read.
 */
const DOC_NAMES = new Set([
  "README",
  "AGENTS",
  "CLAUDE",
  "GEMINI",
  "CHANGELOG",
  "CONTRIBUTING",
  "LICENSE",
  "SECURITY",
  "TODO",
]);

export function isDocFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  if (DOC_NAMES.has(base.toUpperCase())) return true;
  return /^[A-Z0-9]+(?:[_-][A-Z0-9]+)+$/.test(base);
}

/** Never looked into: VCS, dependencies, and hidden directories (`.github`). */
function skipDir(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** Every `.md` file under `root`, as sorted `/`-separated relative paths. */
export function markdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) walk(join(dir, entry.name), rel + "/");
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        found.push(rel);
      }
    }
  };
  walk(root, "");
  return found.sort();
}

/** Whether `path` (relative, `/`-separated) is a deck under `config`. */
export function isDeckPath(path: string, config: Config): boolean {
  if (!path.endsWith(".md")) return false;
  if (config.decks === null) return !isDocFile(path);
  return matchesAny(path, config.decks.include) && !matchesAny(path, config.decks.exclude);
}

export type Problem = {
  kind: "config" | "parse" | "duplicate-card" | "legacy-id";
  severity: "error" | "warning";
  file: string;
  /** 1-based; null when the problem has no one line. */
  line: number | null;
  message: string;
  /** The card's key, for duplicate-card problems. */
  key?: string;
};

export type DeckFile = {
  path: string;
  text: string;
  /** Null when the file does not parse. */
  cards: ParsedCard[] | null;
};

export type Collection = {
  root: string;
  config: ConfigResult;
  files: DeckFile[];
  /**
   * Every card of every file that parses, in file order. The same text twice
   * is one card (PLAN-1.0 §2.7): only the first is here.
   */
  cards: ParsedCard[];
  problems: Problem[];
};

/** The deck name a file gets without a frontmatter `name`, as the app derives it. */
export function defaultDeckName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** `Location: file:12` off the end of a parser message, as a line number. */
function splitLocation(message: string): { message: string; line: number | null } {
  const m = message.match(/^([\s\S]*?)\s*(?:Location: .*:(\d+)|File: .*)$/);
  if (!m) return { message, line: null };
  return { message: m[1], line: m[2] ? Number(m[2]) : null };
}

export async function loadCollection(root: string): Promise<Collection> {
  const config = readConfig(root);
  const problems: Problem[] = config.problems.map((p) => ({
    kind: "config",
    severity: "error",
    file: "hashcards.toml",
    line: p.line,
    message: p.message,
  }));

  const files: DeckFile[] = [];
  const firstOf = new Map<string, ParsedCard>();
  const duplicate = (card: ParsedCard, first: ParsedCard) =>
    problems.push({
      kind: "duplicate-card",
      severity: "warning",
      file: card.filePath,
      line: card.range[0],
      key: card.key,
      message: `the same card as ${locate(first)}: one card, one schedule (whitespace does not count)`,
    });

  for (const path of markdownFiles(root).filter((p) => isDeckPath(p, config.config))) {
    const text = readFileSync(join(root, path), "utf8");
    let cards: ParsedCard[] | null = null;
    try {
      cards = await parseFile(text, path, defaultDeckName(path), duplicate);
    } catch (error) {
      const { message, line } = splitLocation((error as Error).message);
      problems.push({
        kind: "parse",
        severity: "error",
        file: path,
        line: line ?? (await clozeLine(text, path)),
        message,
      });
    }

    if (cards) {
      // Across files: within one, the parser already reported it.
      cards = cards.filter((card) => {
        const first = firstOf.get(card.key);
        if (!first) {
          firstOf.set(card.key, card);
          return true;
        }
        duplicate(card, first);
        return false;
      });
      const { lineOffset, cards: blocks } = scanFile(text, path);
      const legacy = blocks.filter((b) => b.meta?.id);
      if (legacy.length > 0) {
        problems.push({
          kind: "legacy-id",
          severity: "warning",
          file: path,
          line: lineOffset + legacy[0].meta!.id!.line + 1,
          message:
            `${legacy.length === 1 ? "1 ID: line" : `${legacy.length} ID: lines`}: cards are identified by their text now. ` +
            "`hc migrate` removes them and keeps their history",
        });
      }
    }
    files.push({ path, text, cards });
  }

  problems.sort(
    (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
  );
  return {
    root,
    config,
    files,
    cards: files.flatMap((f) => f.cards ?? []),
    problems,
  };
}

/**
 * The parser reports a cloze block without deletions by file only. Find the
 * block, so the error can say where to look.
 */
async function clozeLine(text: string, path: string): Promise<number | null> {
  let scanned;
  try {
    scanned = scanFile(text, path);
  } catch {
    return null;
  }
  for (const block of scanned.cards) {
    if (block.type !== "clozeGroup") continue;
    try {
      await parseFile(`C: ${block.text}`, path, "probe");
    } catch {
      return scanned.lineOffset + block.startLine + 1;
    }
  }
  return null;
}

/** Where a card starts, as `file:line`. */
export function locate(card: ParsedCard): string {
  return `${card.filePath}:${card.range[0]}`;
}
