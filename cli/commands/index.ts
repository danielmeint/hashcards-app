import type { Command } from "../command";
import { add } from "./add";
import { due } from "./due";
import { init } from "./init";
import { fit } from "./later";
import { importCmd } from "./import-anki";
import { migrate } from "./migrate";
import { relink } from "./relink";
import { leeches } from "./leeches";
import { lint } from "./lint";
import { show } from "./show";
import { stats } from "./stats";

/** Every command, in the order `hc --help` lists them. */
export const COMMANDS: Command[] = [lint, add, due, stats, leeches, show, relink, init, migrate, importCmd, fit];
