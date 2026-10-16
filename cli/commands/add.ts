import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFile } from "../../src/parser";
import { defaultDeckName, isDeckPath, loadCollection } from "../collection";
import { CommandError, EXIT, UsageError } from "../command";
import type { Command, Context } from "../command";
import { validateCard } from "../schema";
import { plural } from "../format";

/**
 * Append cards to deck files: from flags, or as JSON in the shape of
 * `schema/card.schema.json` (one object or an array of them).
 *
 * All or nothing. Every card is validated against the schema, every file it
 * would write parsed again with the new block in it, and every new card checked
 * against the collection and the batch (the same text is the same card,
 * PLAN-1.0 §2.7) — and only if all of that passes is anything written. A half-applied batch is the worst outcome for an agent, which
 * would retry it and duplicate the half that landed.
 */

/** A card in the schema's shape. */
export type CardInput = {
  file: string;
  type: "basic" | "cloze";
  question?: string;
  answer?: string;
  text?: string;
  tags?: string[];
  reverse?: boolean;
  extra?: string;
  status?: "active" | "draft" | "suspended";
};

export type AddError = { card: number | null; path: string; message: string };

class AddFailed extends Error {
  constructor(readonly errors: AddError[]) {
    super(errors.map((e) => e.message).join("; "));
  }
}

/**
 * Environment variables that coding agents set. When one is present and the
 * caller did not choose a status, the card is a draft: an agent proposes,
 * the person accepts in the Inbox (PLAN-1.0 M5). `HC_AGENT=1` opts any caller
 * in, `HC_AGENT=0` opts out.
 */
const AGENT_ENV = ["CLAUDECODE", "CODEX_SANDBOX", "GEMINI_CLI", "CURSOR_AGENT"];

export function isAgent(env: Record<string, string | undefined>): boolean {
  if (env.HC_AGENT !== undefined) return env.HC_AGENT !== "0" && env.HC_AGENT !== "";
  return AGENT_ENV.some((name) => env[name]);
}

export const add: Command = {
  name: "add",
  summary: "add cards to a deck, from flags or schema JSON",
  help: `Usage:
  hc add --deck <file.md> -q <question> -a <answer> [options]
  hc add --deck <file.md> --cloze <text with [deletions]> [options]
  hc add --json <file|->                 one card object or an array (schema/card.schema.json)

Appends each card as a new block, after a --- separator. Creates the
deck file, with frontmatter, if it does not exist. Validates everything first
and writes nothing if any card is invalid.

Options:
  --deck <path>        deck file, relative to the repo (fills "file" for --json cards that omit it)
  -q, --question <md>  basic card front
  -a, --answer <md>    basic card back
  --cloze <md>         cloze card; each [bracketed] part becomes its own card
  --tags <a,b>         comma-separated tags
  --reverse            basic cards: also review answer -> question
  --extra <text>       a note shown only after the answer is revealed
  --draft              Status: draft (proposed; accepted later in the app's Inbox)
  --suspended          Status: suspended
  --active             no Status line, even when run by an agent
  --name <deck name>   frontmatter name, when the file is created
  --dry-run            validate and show what would be written, but write nothing
  --json <file|->      read cards as JSON from a file or stdin; output is JSON too

Status defaults to active, or to draft when an agent runs hc (CLAUDECODE,
CODEX_SANDBOX, GEMINI_CLI or CURSOR_AGENT set, or HC_AGENT=1).

Exit: 0 added, 2 invalid input (nothing written).`,
  options: {
    json: { type: "string" },
    deck: { type: "string" },
    question: { type: "string", short: "q" },
    answer: { type: "string", short: "a" },
    cloze: { type: "string" },
    tags: { type: "string" },
    reverse: { type: "boolean" },
    extra: { type: "string" },
    draft: { type: "boolean" },
    suspended: { type: "boolean" },
    active: { type: "boolean" },
    name: { type: "string" },
    "dry-run": { type: "boolean" },
  },
  async run(ctx) {
    try {
      return await addCards(ctx);
    } catch (error) {
      if (!(error instanceof AddFailed)) throw error;
      if (ctx.json) ctx.emit({ ok: false, errors: error.errors });
      else {
        for (const e of error.errors) {
          const which = e.card === null ? "" : `card ${e.card + 1}`;
          const where = [which, e.path].filter(Boolean).join(" ");
          ctx.io.stderr(`hc add: ${where ? where + ": " : ""}${e.message}\n`);
        }
        ctx.io.stderr("nothing was written\n");
      }
      return EXIT.error;
    }
  },
};

async function addCards(ctx: Context): Promise<number> {
  const v = ctx.values;
  const raw = await readInput(ctx);
  const statusFlags = (["draft", "suspended", "active"] as const).filter((s) => v[s]);
  if (statusFlags.length > 1) throw new UsageError(`choose one of --${statusFlags.join(", --")}`);
  const forced = statusFlags[0];
  const agentDraft = isAgent(ctx.io.env);

  const errors: AddError[] = [];
  const cards: CardInput[] = [];
  raw.forEach((value, i) => {
    let card: unknown = value;
    if (isObject(value)) {
      const filled: Record<string, unknown> = { ...value };
      if (filled.file === undefined && typeof v.deck === "string") filled.file = v.deck;
      if (forced) filled.status = forced;
      else if (filled.status === undefined && agentDraft) filled.status = "draft";
      card = filled;
    }
    const problems = validateCard(card);
    for (const p of problems) errors.push({ card: i, path: p.path || "(card)", message: p.message });
    if (problems.length === 0) cards.push(card as CardInput);
  });
  if (errors.length > 0) throw new AddFailed(errors);

  const plan = await planWrites(ctx.repo, cards, typeof v.name === "string" ? v.name : undefined);
  const dryRun = v["dry-run"] === true;
  if (!dryRun) {
    for (const f of plan.files) {
      mkdirSync(dirname(join(ctx.repo, f.path)), { recursive: true });
      writeFileSync(join(ctx.repo, f.path), f.text);
    }
  }

  if (ctx.json) {
    ctx.emit({ ok: true, dryRun, added: plan.added, created: plan.files.filter((f) => f.created).map((f) => f.path) });
  } else {
    for (const a of plan.added) {
      ctx.say(`${dryRun ? "would add" : "added"} ${a.file}:${a.line} (${a.status})  keys: ${a.keys.join(" ")}`);
    }
    for (const f of plan.files.filter((f) => f.created)) ctx.say(`${dryRun ? "would create" : "created"} ${f.path}`);
    if (dryRun) for (const f of plan.files) ctx.say(`\n--- ${f.path} (new text) ---\n${f.text.slice(f.from)}`);
    ctx.say(`${dryRun ? "would add" : "added"} ${plural(plan.added.length, "card")}`);
  }
  return EXIT.ok;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The cards asked for, as unvalidated values. */
async function readInput(ctx: Context): Promise<unknown[]> {
  const v = ctx.values;
  const flagged = ["question", "answer", "cloze", "tags", "reverse", "extra"].filter((k) => v[k] !== undefined);

  if (typeof v.json === "string") {
    if (flagged.length > 0) {
      throw new UsageError(`--json takes the whole card; --${flagged.join(", --")} cannot be combined with it`);
    }
    let text: string;
    if (v.json === "-") text = await ctx.io.stdin();
    else {
      try {
        text = readFileSync(join(ctx.io.cwd, v.json), "utf8");
      } catch {
        throw new CommandError(`cannot read ${v.json}`);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AddFailed([{ card: null, path: "", message: `input is not valid JSON: ${(error as Error).message}` }]);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0) throw new AddFailed([{ card: null, path: "", message: "no cards in the input" }]);
    return list;
  }

  if (v.deck === undefined) throw new UsageError("--deck is required (or give --json)");
  const basic = v.question !== undefined || v.answer !== undefined;
  if (basic && v.cloze !== undefined) throw new UsageError("a card is either -q/-a or --cloze, not both");
  if (!basic && v.cloze === undefined) throw new UsageError("give -q and -a, or --cloze");
  const card: Record<string, unknown> = { file: v.deck, type: basic ? "basic" : "cloze" };
  if (basic) {
    if (v.question !== undefined) card.question = v.question;
    if (v.answer !== undefined) card.answer = v.answer;
  } else card.text = v.cloze;
  if (typeof v.tags === "string") {
    card.tags = [...new Set(v.tags.split(",").map((t) => t.trim()).filter((t) => t !== ""))];
  }
  if (v.reverse) card.reverse = true;
  if (v.extra !== undefined) card.extra = v.extra;
  return [card];
}

/** One card's block, metadata first, as CARD_FORMAT_SPEC.md writes it. */
export function toBlock(card: CardInput): string {
  const lines: string[] = [];
  if (card.tags && card.tags.length > 0) lines.push(`Tags: ${card.tags.join(", ")}`);
  if (card.reverse) lines.push("Reverse: yes");
  if (card.status && card.status !== "active") lines.push(`Status: ${card.status}`);
  if (card.type === "basic") {
    lines.push(`Q: ${card.question!.trim()}`, `A: ${card.answer!.trim()}`);
  } else lines.push(`C: ${card.text!.trim()}`);
  if (card.extra !== undefined && card.extra.trim() !== "") lines.push(`Extra: ${card.extra.trim()}`);
  return lines.join("\n");
}

type Added = { keys: string[]; file: string; line: number; status: string };
type PlannedFile = { path: string; text: string; created: boolean; from: number };

/** Decide every file's new text; throw `AddFailed` if any of it is wrong. */
async function planWrites(
  repo: string,
  cards: CardInput[],
  name: string | undefined
): Promise<{ added: Added[]; files: PlannedFile[] }> {
  const collection = await loadCollection(repo);
  const errors: AddError[] = [];
  const known = new Map(collection.cards.map((c) => [c.key, c]));
  const inBatch = new Map<string, number>();

  cards.forEach((card, i) => {
    if (!isDeckPath(card.file, collection.config.config)) {
      errors.push({
        card: i,
        path: "/file",
        message: `${card.file} is not a deck file here (README-style names and hashcards.toml [decks] excludes are not read as decks)`,
      });
    }
  });
  if (errors.length > 0) throw new AddFailed(errors);

  const byFile = new Map<string, { card: CardInput; index: number }[]>();
  cards.forEach((card, index) => byFile.set(card.file, [...(byFile.get(card.file) ?? []), { card, index }]));

  const files: PlannedFile[] = [];
  const added: Added[] = new Array(cards.length);
  for (const [path, entries] of byFile) {
    const full = join(repo, path);
    const created = !existsSync(full);
    const existing = created ? null : collection.files.find((f) => f.path === path);
    if (existing && existing.cards === null) {
      errors.push({ card: entries[0].index, path: "/file", message: `${path} does not parse; fix it first (hc lint)` });
      continue;
    }

    let text: string;
    let hasCards: boolean;
    if (created) {
      const deckName = name ?? defaultDeckName(path);
      text = `---\nname = ${JSON.stringify(deckName)}\n---`;
      hasCards = false;
    } else {
      text = readFileSync(full, "utf8").replace(/\s+$/, "");
      hasCards = (existing?.cards?.length ?? 0) > 0;
    }
    const from = text.length;
    const lineOf = new Map<number, number>();
    for (const { card, index } of entries) {
      const sep = hasCards ? "\n\n---\n\n" : text === "" ? "" : "\n\n";
      text += sep;
      lineOf.set(index, text.split("\n").length);
      text += toBlock(card);
      hasCards = true;
    }
    text += "\n";

    // The parser is the authority on the result, not the schema.
    let parsed;
    try {
      parsed = await parseFile(text, path, defaultDeckName(path));
    } catch (error) {
      errors.push({ card: entries[0].index, path: "", message: `${path} would not parse: ${(error as Error).message}` });
      continue;
    }
    for (const { card, index } of entries) {
      const keys = parsed.filter((c) => c.range[0] === lineOf.get(index)).map((c) => c.key);
      if (keys.length === 0) {
        // The parser drops a block whose text is already in the file.
        errors.push({ card: index, path: "", message: `${path} already has a card with exactly this text` });
      }
      for (const key of keys) {
        const there = known.get(key);
        const twice = inBatch.get(key);
        if (there && there.filePath !== path) {
          errors.push({ card: index, path: "", message: `${there.filePath}:${there.range[0]} already has a card with exactly this text` });
        } else if (twice !== undefined && twice !== index) {
          errors.push({ card: index, path: "", message: `card ${twice + 1} of this batch has exactly this text` });
        }
        inBatch.set(key, index);
      }
      added[index] = {
        keys,
        file: path,
        line: lineOf.get(index)!,
        status: card.status ?? "active",
      };
    }
    files.push({ path, text, created, from });
  }
  if (errors.length > 0) throw new AddFailed(errors);
  return { added, files };
}
