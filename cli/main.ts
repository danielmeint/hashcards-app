import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { COMMANDS } from "./commands/index";
import { CommandError, EXIT, UsageError } from "./command";
import type { Command, Context, Io } from "./command";

/** Options every command takes. `add` redefines `--json` to take its input. */
const GLOBAL_OPTIONS = {
  repo: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const GLOBAL_HELP = `Global options:
  --repo <dir>   the card repo (a local clone); default: the current directory
  --json         machine-readable output on stdout
  -h, --help     this help`;

function overview(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return `hc ${pkg.version}: hashcards from the command line

Usage: hc <command> [options]

Commands:
${lines.join("\n")}

${GLOBAL_HELP}

Exit codes: 0 ok, 1 findings (lint errors, leeches, no such card), 2 usage or error.
Run \`hc <command> --help\` for a command's options.`;
}

export function nodeIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    now: () => new Date(),
  };
}

/** Run `hc` with `argv` (without `node hc`), returning the exit code. */
export async function main(argv: string[], io: Io = nodeIo()): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    io.stdout(overview() + "\n");
    return name === undefined ? EXIT.error : EXIT.ok;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    io.stdout(pkg.version + "\n");
    return EXIT.ok;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    io.stderr(`hc: unknown command '${name}'. Run \`hc --help\` for the list.\n`);
    return EXIT.error;
  }
  // Decided before parsing, so that even a usage error can answer in JSON to a
  // caller that asked for it.
  const wantsJson = rest.some((a) => a === "--json" || a.startsWith("--json="));
  try {
    return await runCommand(command, rest, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError || error instanceof CommandError) {
      const hint = error instanceof UsageError ? ` See \`hc ${command.name} --help\`.` : "";
      if (wantsJson) io.stdout(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
      else io.stderr(`hc ${command.name}: ${message}${hint}\n`);
      return EXIT.error;
    }
    throw error;
  }
}

async function runCommand(command: Command, args: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // parseArgs's own messages are good; only its error class is unhelpful.
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(`${command.help.trim()}\n\n${GLOBAL_HELP}\n`);
    return EXIT.ok;
  }
  const max = command.positionals ?? 0;
  if (positionals.length > max) {
    throw new UsageError(`unexpected argument '${positionals[max]}'`);
  }

  const repo = resolve(io.cwd, typeof values.repo === "string" ? values.repo : ".");
  if (!statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CommandError(`${repo} is not a directory`);
  }
  // `add --json <file>` reads JSON, and so answers in it.
  const json = values.json === true || typeof values.json === "string";
  const ctx: Context = {
    io,
    repo,
    json,
    values: values as Context["values"],
    positionals,
    say: (text = "") => {
      if (!json) io.stdout(text + "\n");
    },
    emit: (value) => io.stdout(JSON.stringify(value, null, 2) + "\n"),
  };
  return command.run(ctx);
}
