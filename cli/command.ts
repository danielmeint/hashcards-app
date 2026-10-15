import type { ParseArgsOptionsConfig } from "node:util";

/**
 * The shape every `hc` command has, so that one still to be written (M4's
 * `migrate`, M6's `import anki`, M7's `fit`) slots in by adding a file to
 * `commands/` and a line to `commands/index.ts`, nothing more.
 */

/** Exit codes, the same for every command. */
export const EXIT = {
  ok: 0,
  /** The command ran and found something: lint errors, leeches, no such card. */
  findings: 1,
  /** Bad arguments, a broken repo, anything that kept the command from running. */
  error: 2,
} as const;

/** Everything a command touches outside itself, so tests can stand it in. */
export type Io = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of standard input, for `--json -`. */
  stdin(): Promise<string>;
  now(): Date;
};

export type Context = {
  io: Io;
  /** The card repo: `--repo`, resolved, or the working directory. */
  repo: string;
  /** Machine-readable output was asked for. */
  json: boolean;
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** Write one line (or block) of human output. Silent under `--json`. */
  say(text?: string): void;
  /** Write the JSON result. */
  emit(value: unknown): void;
};

export type Command = {
  name: string;
  /** One line, for `hc --help`. */
  summary: string;
  /** The full `hc <name> --help` text, minus the global options. */
  help: string;
  options: ParseArgsOptionsConfig;
  /** Positional arguments accepted, at most. */
  positionals?: number;
  run(ctx: Context): Promise<number>;
};

/** A problem with how the command was called: exit 2, with a pointer to `--help`. */
export class UsageError extends Error {}

/** A problem that stops the command, not the caller's fault: exit 2. */
export class CommandError extends Error {}
