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
  kind: "config" | "parse" | "duplicate-id" | "missing-id";
  severity: "error" | "warning";
  file: string;
  /** 1-based; null when the problem has no one line. */
  line: number | null;
  message: string;
  /** The card's ID, for duplicate-ID problems. */
  id?: string;
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
  /** Every card of every file that parses, in file order. */
  cards: ParsedCard[];
  /** Every ID written in any deck file, parseable or not, with where. */
  ids: Map<string, { file: string; line: number }[]>;
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
  const ids = new Map<string, { file: string; line: number }[]>();
  const noteId = (id: string, file: string, line: number) => {
    const at = ids.get(id) ?? [];
    at.push({ file, line });
    ids.set(id, at);
  };

  for (const path of markdownFiles(root).filter((p) => isDeckPath(p, config.config))) {
    const text = readFileSync(join(root, path), "utf8");
    let cards: ParsedCard[] | null = null;
    try {
      cards = await parseFile(text, path, defaultDeckName(path));
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
      // Parsed, so scanning cannot fail. The scan has the line of each ID and
      // of each block top, which parsed cards no longer do.
      const { lineOffset, cards: blocks } = scanFile(text, path);
      for (const block of blocks) {
        if (block.meta?.id) noteId(block.meta.id.value, path, lineOffset + block.meta.id.line + 1);
        else {
          problems.push({
            kind: "missing-id",
            severity: "warning",
            file: path,
            line: lineOffset + block.startLine + 1,
            message: "card has no ID: `hc lint --fix` stamps one",
          });
        }
      }
    } else {
      // A file that does not parse still owns its IDs: a new one stamped
      // elsewhere must not take one of them.
      text.split("\n").forEach((line, i) => {
        const m = line.match(/^ID:\s*(\S+)\s*$/);
        if (m) noteId(m[1], path, i + 1);
      });
    }
    files.push({ path, text, cards });
  }

  for (const [id, at] of ids) {
    // Within one file the parser already refuses a repeat; this is across files.
    if (new Set(at.map((a) => a.file)).size < 2) continue;
    const [first, ...rest] = at;
    for (const dup of rest) {
      if (dup.file === first.file) continue;
      problems.push({
        kind: "duplicate-id",
        severity: "error",
        file: dup.file,
        line: dup.line,
        id,
        message: `duplicate ID '${id}', also used at ${first.file}:${first.line}`,
      });
    }
  }

  problems.sort(
    (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
  );
  return {
    root,
    config,
    files,
    cards: files.flatMap((f) => f.cards ?? []),
    ids,
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
