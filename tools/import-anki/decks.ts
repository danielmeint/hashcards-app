/**
 * Reading an ankictl deck repo, and writing hashcards v2 deck files.
 *
 * Mirrors ankictl's own loader (ankictl/files.py, config.py) closely, so a
 * note means here exactly what it meant when ankictl pushed it to Anki.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

export type AnkictlConfig = {
  decksDir: string;
  keyField: string;
  defaultNotetype: string;
  clozeNotetype: string;
  orphanTag: string;
};

/** ankictl's defaults (config.py), overridden by `ankictl.yaml`. */
export function loadAnkictlConfig(repo: string): AnkictlConfig {
  const path = join(repo, "ankictl.yaml");
  const data = existsSync(path) ? ((parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {}) : {};
  const str = (k: string, d: string) => (typeof data[k] === "string" ? (data[k] as string) : d);
  return {
    decksDir: str("decks_dir", "decks"),
    keyField: str("key_field", "Key"),
    defaultNotetype: str("default_notetype", "Flashcards-as-Code Basic"),
    clozeNotetype: str("cloze_notetype", "Flashcards-as-Code Cloze"),
    orphanTag: str("orphan_tag", "fac::orphan"),
  };
}

export type DeckNote = {
  key: string;
  notetype: string;
  /** Only the note's own tags; the file's tags apply on top, as in ankictl. */
  tags: string[];
  /** YAML key (lowercased field name) -> Markdown. */
  md: Record<string, string>;
  /** YAML key without `_html` -> raw HTML. */
  raw: Record<string, string>;
};

export type DeckFile = {
  /** Relative to the decks dir, for messages. */
  source: string;
  deck: string;
  tags: string[];
  notes: DeckNote[];
};

const RESERVED = new Set(["key", "notetype", "tags"]);
const RAW_SUFFIX = "_html";

/**
 * Field values as ankictl read them: PyYAML is YAML 1.1 and ankictl does
 * `str(value)`, so `yes` was the string "True" in Anki. Same here.
 */
function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function parseDeckFile(text: string, source: string): DeckFile {
  const data = parseYaml(text, { version: "1.1" }) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") throw new Error(`${source}: top level must be a mapping`);
  const deck = data.deck;
  if (typeof deck !== "string" || !deck) throw new Error(`${source}: missing required 'deck:'`);
  const fileNotetype = typeof data.notetype === "string" ? data.notetype : null;

  const notes = ((data.notes as unknown[]) ?? []).map((entry, i): DeckNote => {
    if (!entry || typeof entry !== "object") throw new Error(`${source}: note #${i + 1} must be a mapping`);
    const e = entry as Record<string, unknown>;
    if (e.key === undefined || e.key === null || e.key === "") {
      throw new Error(`${source}: note #${i + 1} is missing 'key:'`);
    }
    const key = String(e.key);
    const notetype = (typeof e.notetype === "string" && e.notetype) || fileNotetype;
    if (!notetype) throw new Error(`${source}: note '${key}' has no notetype and the file sets no default`);
    const md: Record<string, string> = {};
    const raw: Record<string, string> = {};
    for (const [name, value] of Object.entries(e)) {
      if (RESERVED.has(name)) continue;
      if (name.endsWith(RAW_SUFFIX)) raw[name.slice(0, -RAW_SUFFIX.length)] = fieldText(value);
      else md[name] = fieldText(value);
    }
    return { key, notetype, tags: tagList(e.tags), md, raw };
  });

  return { source, deck, tags: tagList(data.tags), notes };
}

/** Every `*.yaml` under the decks dir, sorted, like ankictl's `rglob`. */
export function loadDeckFiles(decksPath: string): DeckFile[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".yaml")) files.push(path);
    }
  };
  walk(decksPath);
  files.sort();
  return files.map((p) => parseDeckFile(readFileSync(p, "utf8"), relative(decksPath, p)));
}

// --------------------------------------------------------------------------
// Writing

export type OutCard = {
  id: string;
  tags: string[];
  status: "suspended" | null;
  reverse: boolean;
  /** The card's `Extra:` section, shown after reveal; null for none. */
  extra: string | null;
} & ({ type: "basic"; question: string; answer: string } | { type: "cloze"; text: string });

export type OutDeck = { name: string; tags: string[]; cards: OutCard[] };

/** TOML basic strings take JSON's escapes for everything that can occur here. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function side(tag: "Q" | "A" | "C" | "Extra", text: string): string {
  // `Q:` alone then the text is equivalent (the parser trims), and keeps a
  // first line that is empty, or indented, from being changed by the trim.
  return text === "" || /^\s/.test(text) ? `${tag}:\n${text}` : `${tag}: ${text}`;
}

export function renderCard(card: OutCard): string {
  const lines = [`ID: ${card.id}`];
  if (card.tags.length) lines.push(`Tags: ${card.tags.join(", ")}`);
  if (card.reverse) lines.push("Reverse: yes");
  if (card.status) lines.push(`Status: ${card.status}`);
  if (card.type === "basic") {
    lines.push(side("Q", card.question), side("A", card.answer));
  } else {
    lines.push(side("C", card.text));
  }
  if (card.extra) lines.push(side("Extra", card.extra));
  return lines.join("\n");
}

/** A whole v2 deck file: TOML frontmatter, then cards between `---`. */
export function renderDeck(deck: OutDeck): string {
  const front = ["---", `name = ${tomlString(deck.name)}`];
  if (deck.tags.length) front.push(`tags = [${deck.tags.map(tomlString).join(", ")}]`);
  front.push("---");
  return front.join("\n") + "\n\n" + deck.cards.map(renderCard).join("\n\n---\n\n") + "\n";
}
